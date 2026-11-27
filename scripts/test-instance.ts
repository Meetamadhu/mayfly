/**
 * Instance naming for multi-host setups. Run with: npx tsx scripts/test-instance.ts
 */
import assert from "node:assert/strict";
import { instanceName, instanceRepos } from "../src/lib/instance";

assert.equal(instanceName({}), "mayfly");
assert.equal(instanceName({ MAYFLY_INSTANCE: "aws-east-1" }), "aws-east-1");
assert.equal(instanceName({ MAYFLY_INSTANCE: "  edge  ", HOSTNAME: "box" }), "edge");
assert.equal(instanceName({ RENDER_SERVICE_NAME: "mayfly-prod" }), "mayfly-prod");
assert.equal(instanceName({ HOSTNAME: "ip-10-0-0-1" }), "ip-10-0-0-1");

assert.equal(instanceRepos({ PREVIEW_RUNTIME: "process" }), null);
assert.deepEqual(instanceRepos({ PREVIEW_RUNTIME: "docker", PREVIEW_REPOS: "Acme/Web, other/app" }), ["acme/web", "other/app"]);
assert.deepEqual(instanceRepos({ PREVIEW_RUNTIME: "docker", PREVIEW_REPOS: "" }), []);
assert.equal(instanceRepos({ PREVIEW_RUNTIME: "docker", DEPLOYER: "fake" }), null);

console.log("instance: ok");
