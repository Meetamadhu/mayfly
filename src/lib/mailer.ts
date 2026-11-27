import { randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

/**
 * A small SMTP client, enough to send the weekly summary without a mail library. Set SMTP_URL:
 *   smtp://user:password@smtp.example.com:587    STARTTLS on the usual submission port
 *   smtps://user:password@smtp.example.com:465   TLS from the first byte
 *   smtp://localhost:25                           a local relay, no login
 * A login is never sent over a connection that isn't encrypted, unless the server is on this machine.
 */

export interface SmtpTarget {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
}

export function parseSmtpUrl(value: string | undefined): SmtpTarget | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "smtp:" && url.protocol !== "smtps:") return null;
    const secure = url.protocol === "smtps:";
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : secure ? 465 : 587,
      secure,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  } catch {
    return null;
  }
}

export interface Mail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Header text on one line: no way for a subject or name to add headers of its own. */
function oneLine(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function encodeHeader(value: string) {
  const clean = oneLine(value);
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

/** The address inside "Name <a@b.c>", or the text itself. */
export function addressOf(value: string) {
  const match = /<([^<>\s]+)>\s*$/.exec(value);
  return (match ? match[1] : value).trim();
}

/** The message as it goes over the wire: CRLF lines, dots at the start of a line doubled. */
export function buildMessage(mail: Mail, now = new Date(), boundary = `mayfly-${randomUUID()}`) {
  const headers = [
    `From: ${oneLine(mail.from)}`,
    `To: ${mail.to.map(oneLine).join(", ")}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomUUID()}@mayfly>`,
    "MIME-Version: 1.0",
  ];
  const wrap = (text: string) => Buffer.from(text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  let body: string[];
  if (mail.html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: base64",
      "",
      wrap(mail.text),
      `--${boundary}`,
      'Content-Type: text/html; charset="utf-8"',
      "Content-Transfer-Encoding: base64",
      "",
      wrap(mail.html),
      `--${boundary}--`,
    ];
  } else {
    headers.push('Content-Type: text/plain; charset="utf-8"', "Content-Transfer-Encoding: base64");
    body = [wrap(mail.text)];
  }
  const raw = [...headers, "", ...body].join("\r\n");
  return raw.replace(/^\./gm, "..");
}

type Reply = { code: number; lines: string[] };

/** Reads an SMTP conversation: one reply at a time, however the bytes are split. */
class Conversation {
  private buffer = "";
  private waiting: ((reply: Reply) => void) | null = null;
  private failed: ((error: Error) => void) | null = null;
  private queue: Reply[] = [];
  private current: string[] = [];
  private error: Error | null = null;

  constructor(private socket: net.Socket) {
    this.attach(socket);
  }

  private attach(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let at: number;
      while ((at = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, at).replace(/\r$/, "");
        this.buffer = this.buffer.slice(at + 1);
        const match = /^(\d{3})([ -])(.*)$/.exec(line);
        if (!match) continue;
        this.current.push(match[3]);
        if (match[2] === " ") {
          const reply = { code: Number(match[1]), lines: this.current };
          this.current = [];
          if (this.waiting) {
            const wake = this.waiting;
            this.waiting = null;
            wake(reply);
          } else this.queue.push(reply);
        }
      }
    });
    const fail = (error: Error) => {
      this.error = error;
      this.failed?.(error);
    };
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("The mail server closed the connection.")));
  }

  /** After STARTTLS the same conversation continues on the encrypted socket. */
  swap(socket: net.Socket) {
    this.buffer = "";
    this.attach(socket);
  }

  get raw() {
    return this.socket;
  }

  read(timeoutMs = 20_000): Promise<Reply> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The mail server didn't answer in time.")), timeoutMs);
      this.waiting = (reply) => {
        clearTimeout(timer);
        resolve(reply);
      };
      this.failed = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  async command(line: string, expect: number[]): Promise<Reply> {
    this.socket.write(`${line}\r\n`);
    return this.expect(await this.read(), expect, line.split(" ")[0]);
  }

  expect(reply: Reply, expect: number[], what: string) {
    if (!expect.includes(reply.code)) throw new Error(`The mail server refused ${what}: ${reply.code} ${reply.lines[0] ?? ""}`.trim());
    return reply;
  }
}

/** Send one email. Throws with a sentence that says what went wrong (never the password). */
export async function sendMail(target: SmtpTarget, mail: Mail, options: { clientName?: string; now?: Date } = {}): Promise<void> {
  if (mail.to.length === 0) throw new Error("There's nobody to send it to.");
  const local = LOCAL_HOSTS.has(target.host.toLowerCase());
  let socket: net.Socket = await new Promise<net.Socket>((resolve, reject) => {
    const connected = target.secure
      ? tls.connect({ host: target.host, port: target.port, servername: target.host }, () => resolve(connected))
      : net.connect({ host: target.host, port: target.port }, () => resolve(connected));
    connected.setTimeout(30_000, () => connected.destroy(new Error("Couldn't reach the mail server in time.")));
    connected.once("error", (error) => reject(new Error(`Couldn't reach the mail server: ${(error as NodeJS.ErrnoException).code ?? error.message}`)));
  });
  const talk = new Conversation(socket);
  try {
    talk.expect(await talk.read(), [220], "the connection");
    const name = options.clientName ?? "mayfly";
    let ehlo = await talk.command(`EHLO ${name}`, [250]);
    let encrypted = target.secure;
    if (!encrypted && ehlo.lines.some((line) => /^STARTTLS$/i.test(line.trim()))) {
      await talk.command("STARTTLS", [220]);
      const upgraded = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const secured = tls.connect({ socket, servername: target.host }, () => resolve(secured));
        secured.once("error", (error) => reject(new Error(`The mail server's certificate wasn't accepted: ${error.message}`)));
      });
      socket = upgraded;
      talk.swap(upgraded);
      encrypted = true;
      ehlo = await talk.command(`EHLO ${name}`, [250]);
    }
    if (target.user) {
      if (!encrypted && !local) throw new Error("The mail server doesn't offer an encrypted connection, so the login wasn't sent. Use smtps:// or a server with STARTTLS.");
      const methods = ehlo.lines.find((line) => /^AUTH\b/i.test(line.trim()))?.toUpperCase() ?? "";
      if (methods.includes("PLAIN") || !methods) {
        const token = Buffer.from(`\u0000${target.user}\u0000${target.password}`, "utf8").toString("base64");
        await talk.command(`AUTH PLAIN ${token}`, [235]);
      } else if (methods.includes("LOGIN")) {
        await talk.command("AUTH LOGIN", [334]);
        await talk.command(Buffer.from(target.user).toString("base64"), [334]);
        await talk.command(Buffer.from(target.password).toString("base64"), [235]);
      } else {
        throw new Error("The mail server needs a kind of login Mayfly doesn't support.");
      }
    }
    await talk.command(`MAIL FROM:<${addressOf(mail.from)}>`, [250]);
    for (const to of mail.to) await talk.command(`RCPT TO:<${addressOf(to)}>`, [250, 251]);
    await talk.command("DATA", [354]);
    socket.write(`${buildMessage(mail, options.now)}\r\n.\r\n`);
    talk.expect(await talk.read(), [250], "the message");
    socket.write("QUIT\r\n");
    // The mail is accepted; wait a moment for the goodbye so the server sees a tidy end, but don't fail on it.
    await talk.read(2_000).catch(() => undefined);
  } finally {
    socket.end();
    socket.destroy();
  }
}

export interface MailSettings {
  target: SmtpTarget;
  from: string;
}

/** The server's mail settings, or why mail can't be sent. */
export function mailSettings(env: Record<string, string | undefined> = process.env): { ok: true; settings: MailSettings } | { ok: false; problem: string } {
  if (!(env["SMTP_URL"] ?? "").trim()) return { ok: false, problem: "Email isn't set up. Add SMTP_URL to the server's settings." };
  const target = parseSmtpUrl(env["SMTP_URL"]);
  if (!target) return { ok: false, problem: "SMTP_URL should look like smtp://user:password@host:587." };
  const from = oneLine(env["REPORT_EMAIL_FROM"] ?? "");
  if (!from || !/^[^\s@<>]+@[^\s@<>]+$/.test(addressOf(from))) {
    return { ok: false, problem: "Add REPORT_EMAIL_FROM, the address the summary is sent from (for example Mayfly <mayfly@yourcompany.com>)." };
  }
  return { ok: true, settings: { target, from } };
}
