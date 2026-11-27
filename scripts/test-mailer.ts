/**
 * The SMTP client against a small fake mail server: the conversation (greeting, EHLO, login, envelope, DATA), the
 * message that comes out, headers that can't be injected, a login that is never sent without encryption, and the
 * errors a person would see. Run with: npx tsx scripts/test-mailer.ts
 */
import assert from "node:assert/strict";
import net, { type AddressInfo } from "node:net";
import { addressOf, buildMessage, mailSettings, parseSmtpUrl, sendMail } from "../src/lib/mailer";

type Script = { ehlo?: string[]; rejectAuth?: boolean; rejectRcpt?: string; silent?: boolean };

/** A fake server. `log` collects what the client said; `messages` the finished emails. */
function fakeServer(script: Script = {}) {
  const log: string[] = [];
  const messages: string[] = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    if (script.silent) return;
    socket.write("220 fake ESMTP ready\r\n");
    let buffer = "";
    let data: string[] | null = null;
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (data) {
          if (line === ".") {
            messages.push(data.join("\r\n"));
            data = null;
            socket.write("250 queued\r\n");
          } else data.push(line.startsWith("..") ? line.slice(1) : line);
          continue;
        }
        log.push(line.startsWith("AUTH PLAIN ") ? "AUTH PLAIN <token>" : line);
        if (/^EHLO /.test(line)) {
          const extra = script.ehlo ?? ["AUTH PLAIN LOGIN", "8BITMIME"];
          socket.write(["250-fake greets you", ...extra.slice(0, -1).map((item) => `250-${item}`), `250 ${extra.at(-1) ?? "OK"}`].join("\r\n") + "\r\n");
        } else if (/^AUTH PLAIN /.test(line)) {
          const [, user, pass] = Buffer.from(line.slice(11), "base64").toString("utf8").split("\u0000");
          log.push(`login:${user}:${pass}`);
          socket.write(script.rejectAuth ? "535 5.7.8 bad credentials\r\n" : "235 welcome\r\n");
        } else if (/^MAIL FROM:/.test(line)) socket.write("250 ok\r\n");
        else if (/^RCPT TO:/.test(line)) socket.write(script.rejectRcpt && line.includes(script.rejectRcpt) ? "550 no such user\r\n" : "250 ok\r\n");
        else if (line === "DATA") {
          data = [];
          socket.write("354 go ahead\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("500 what?\r\n");
      }
    });
    socket.on("error", () => {});
  });
  return new Promise<{ port: number; log: string[]; messages: string[]; close: () => void }>((resolve) => {
    server.listen(0, "0.0.0.0", () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        log,
        messages,
        close: () => {
          server.close();
        },
      }),
    );
  });
}

/** Undo the base64 body parts of a message. */
function bodies(message: string) {
  return [...message.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)(?:\r\n--|$)/g)].map((m) => Buffer.from(m[1].replace(/\r\n/g, ""), "base64").toString("utf8"));
}

async function main() {
  // Settings from the environment.
  assert.deepEqual(parseSmtpUrl("smtp://me%40x.com:p%40ss@mail.example.com:2525"), { host: "mail.example.com", port: 2525, secure: false, user: "me@x.com", password: "p@ss" });
  assert.equal(parseSmtpUrl("smtps://u:p@h")?.port, 465);
  assert.equal(parseSmtpUrl("smtp://h")?.port, 587);
  assert.equal(parseSmtpUrl("https://h"), null);
  assert.equal(parseSmtpUrl("not a url"), null);
  assert.equal(parseSmtpUrl(""), null);
  assert.equal(mailSettings({}).ok, false);
  assert.match((mailSettings({ SMTP_URL: "smtp://h" }) as { problem: string }).problem, /REPORT_EMAIL_FROM/);
  assert.match((mailSettings({ SMTP_URL: "ftp://h", REPORT_EMAIL_FROM: "a@b.c" }) as { problem: string }).problem, /SMTP_URL/);
  assert.equal(mailSettings({ SMTP_URL: "smtp://h", REPORT_EMAIL_FROM: "Mayfly <a@b.c>" }).ok, true);
  assert.equal(addressOf("Mayfly <a@b.c>"), "a@b.c");
  assert.equal(addressOf("a@b.c"), "a@b.c");

  // The message itself.
  const raw = buildMessage(
    { from: "Mayfly <a@b.c>", to: ["x@y.z", "q@y.z"], subject: "Weekly: 12 h saved ✓\r\nBcc: attacker@evil.test", text: ".leading dot\nline two", html: "<p>hi</p>" },
    new Date("2026-11-26T12:00:00Z"),
    "BOUNDARY",
  );
  assert.ok(!/^Bcc:/m.test(raw), "a subject can't add headers");
  assert.match(raw, /^Subject: =\?UTF-8\?B\?/m, "non-ASCII subjects are encoded");
  assert.match(raw, /^Date: Thu, 26 Nov 2026 12:00:00 \+0000$/m);
  assert.match(raw, /^To: x@y\.z, q@y\.z$/m);
  assert.match(raw, /multipart\/alternative; boundary="BOUNDARY"/);
  assert.deepEqual(bodies(raw), [".leading dot\nline two", "<p>hi</p>"]);
  assert.ok(raw.split("\r\n").every((line) => line.length <= 998));

  // A whole conversation with a login.
  const server = await fakeServer();
  try {
    await sendMail(
      { host: "localhost", port: server.port, secure: false, user: "me", password: "pw" },
      { from: "Mayfly <mayfly@example.com>", to: ["ann@example.com", "bo@example.com"], subject: "Hello", text: "Body text\n.\nafter a lone dot", html: "<b>Body</b>" },
      { clientName: "test-host" },
    );
    assert.deepEqual(server.log, [
      "EHLO test-host",
      "AUTH PLAIN <token>",
      "login:me:pw",
      "MAIL FROM:<mayfly@example.com>",
      "RCPT TO:<ann@example.com>",
      "RCPT TO:<bo@example.com>",
      "DATA",
      "QUIT",
    ]);
    assert.equal(server.messages.length, 1);
    assert.match(server.messages[0], /^From: Mayfly <mayfly@example.com>$/m);
    assert.deepEqual(bodies(server.messages[0]), ["Body text\n.\nafter a lone dot", "<b>Body</b>"], "the text arrives intact, lone dots included");
  } finally {
    server.close();
  }

  // No login: no AUTH step. Plain text only: a single part.
  const open = await fakeServer({ ehlo: ["SIZE 1000"] });
  try {
    await sendMail({ host: "127.0.0.1", port: open.port, secure: false, user: "", password: "" }, { from: "a@b.c", to: ["d@e.f"], subject: "Plain", text: "just text" });
    assert.ok(!open.log.some((line) => line.startsWith("AUTH")));
    assert.deepEqual(bodies(open.messages[0]), ["just text"]);
  } finally {
    open.close();
  }

  // A wrong password says so.
  const strict = await fakeServer({ rejectAuth: true });
  try {
    await assert.rejects(
      sendMail({ host: "localhost", port: strict.port, secure: false, user: "me", password: "wrong" }, { from: "a@b.c", to: ["d@e.f"], subject: "s", text: "t" }),
      /refused AUTH: 535/,
    );
  } finally {
    strict.close();
  }

  // A refused recipient names the problem.
  const picky = await fakeServer({ rejectRcpt: "nobody@" });
  try {
    await assert.rejects(
      sendMail({ host: "127.0.0.1", port: picky.port, secure: false, user: "", password: "" }, { from: "a@b.c", to: ["nobody@example.com"], subject: "s", text: "t" }),
      /refused RCPT: 550/,
    );
  } finally {
    picky.close();
  }

  // A login is never sent over an unencrypted connection to another machine (127.0.0.2 isn't "this machine" to the check).
  const remote = await fakeServer();
  try {
    await assert.rejects(
      sendMail({ host: "127.0.0.2", port: remote.port, secure: false, user: "me", password: "secret" }, { from: "a@b.c", to: ["d@e.f"], subject: "s", text: "t" }),
      /login wasn't sent/,
    );
    assert.ok(!remote.log.some((line) => line.includes("secret") || line.startsWith("login:") || line.startsWith("AUTH")), "the password never went out");
  } finally {
    remote.close();
  }

  // Nobody to send to; a closed port; a server that never says hello.
  await assert.rejects(sendMail({ host: "localhost", port: 1, secure: false, user: "", password: "" }, { from: "a@b.c", to: [], subject: "s", text: "t" }), /nobody to send it to/);
  await assert.rejects(sendMail({ host: "127.0.0.1", port: 9, secure: false, user: "", password: "" }, { from: "a@b.c", to: ["d@e.f"], subject: "s", text: "t" }), /Couldn't reach the mail server/);

  console.log("mailer: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
