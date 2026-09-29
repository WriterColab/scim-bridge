import assert from "node:assert/strict";
import { test } from "node:test";
import { IMAGE, parseVersion, promote, publish } from "./writer-image.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const other = `sha256:${"b".repeat(64)}`;
function registry(initial = {}, { error, corruptWrite = false } = {}) {
  const state = new Map(Object.entries(initial));
  const writes = [];
  const run = (command, args) => {
    if (args.includes("list")) {
      if (error) throw new Error(error);
      return JSON.stringify(
        [...state].map(([tag, version]) => ({
          tag: `projects/p/locations/us/repositories/writer/packages/scim-bridge/tags/${tag}`,
          version: `projects/p/locations/us/repositories/writer/packages/scim-bridge/versions/${version}`,
        })),
      );
    }
    if (command === "gcloud" && args.includes("add")) {
      writes.push([command, ...args]);
      state.set(args[5].split(":").at(-1), corruptWrite ? other : args[4].split("@")[1]);
      return "";
    }
    if (command === "docker" && args[0] === "tag") {
      writes.push([command, ...args]);
      return "";
    }
    if (command === "docker" && args[0] === "push") {
      writes.push([command, ...args]);
      state.set(args[1].split(":").at(-1), corruptWrite ? other : digest);
      return "";
    }
    if (command === "docker" && args[0] === "image") return JSON.stringify([`${IMAGE}@${digest}`]);
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  return { state, writes, run };
}

test("strict versions reject suffixes, leading zeros and injected input", () => {
  assert.equal(parseVersion("1.2.3").dev_tag, "1.2.3-dev");
  assert.equal(parseVersion("0.0.0-dev", true).release_tag, "0.0.0-release");
  for (const version of [
    undefined,
    "",
    "v1.2.3",
    "01.2.3",
    "1.2",
    "1.2.3-dev",
    "1.2.3\n",
    "1.2.3;id",
    "$(id)",
  ]) {
    assert.throws(() => parseVersion(version));
  }
  for (const version of ["1.2.3", "1.2.3-release", "1.2.3-dev-dev", "1.2.3-dev\n"]) {
    assert.throws(() => parseVersion(version, true));
  }
});

test("publishing pushes the tested image and verifies its digest", () => {
  const r = registry();
  assert.deepEqual(publish("1.2.3", r.run), { image: `${IMAGE}:1.2.3-dev`, digest });
  assert.deepEqual(r.writes, [
    ["docker", "tag", "scim-bridge:writer", `${IMAGE}:1.2.3-dev`],
    ["docker", "push", `${IMAGE}:1.2.3-dev`],
  ]);
});

test("a published dev tag cannot be overwritten, even with identical content", () => {
  const r = registry({ "1.2.3-dev": digest });
  assert.throws(() => publish("1.2.3", r.run), /already exists/);
  assert.deepEqual(r.writes, []);
});

test("registry permission and network failures abort both operations without writes", () => {
  for (const error of ["PERMISSION_DENIED", "connection timed out"]) {
    const r = registry({}, { error });
    assert.throws(() => publish("1.2.3", r.run), new RegExp(error));
    assert.throws(() => promote("1.2.3-dev", r.run), new RegExp(error));
    assert.deepEqual(r.writes, []);
  }
});

test("promotion tags the source digest without pulling or rebuilding", () => {
  const r = registry({ "1.2.3-dev": digest });
  assert.equal(promote("1.2.3-dev", r.run).digest, digest);
  assert.deepEqual(r.writes, [
    [
      "gcloud",
      "artifacts",
      "docker",
      "tags",
      "add",
      `${IMAGE}@${digest}`,
      `${IMAGE}:1.2.3-release`,
      "--quiet",
    ],
  ]);
});

test("a missing dev tag or conflicting release aborts promotion", () => {
  const missing = registry();
  assert.throws(() => promote("1.2.3-dev", missing.run), /does not exist/);
  assert.deepEqual(missing.writes, []);
  const conflict = registry({ "1.2.3-dev": digest, "1.2.3-release": other });
  assert.throws(() => promote("1.2.3-dev", conflict.run), /different digest/);
  assert.deepEqual(conflict.writes, []);
});

test("repeating a promotion to the same digest is safe", () => {
  const r = registry({ "1.2.3-dev": digest, "1.2.3-release": digest });
  assert.equal(promote("1.2.3-dev", r.run).digest, digest);
  assert.deepEqual(r.writes, []);
});

test("verification detects a wrong digest after publishing or promoting", () => {
  assert.throws(
    () => publish("1.2.3", registry({}, { corruptWrite: true }).run),
    /digest mismatch/,
  );
  assert.throws(
    () => promote("1.2.3-dev", registry({ "1.2.3-dev": digest }, { corruptWrite: true }).run),
    /digest mismatch/,
  );
});

test("malformed registry responses fail closed", () => {
  for (const result of ["not json", "{}", '[{"tag":"x","version":"bad"}]']) {
    const run = () => result;
    assert.throws(() => publish("1.2.3", run));
    assert.throws(() => promote("1.2.3-dev", run));
  }
});
