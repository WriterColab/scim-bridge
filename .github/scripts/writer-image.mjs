import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const IMAGE = "us-docker.pkg.dev/writer-shared/writer/scim-bridge";
const LOCAL_IMAGE = "scim-bridge:writer";
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function parseVersion(input, dev = false) {
  const base = dev && input?.endsWith("-dev") ? input.slice(0, -4) : input;
  if (
    typeof base !== "string" ||
    base.match(SEMVER)?.[0] !== base ||
    (dev && input !== `${base}-dev`)
  ) {
    throw new Error(`Version must be X.Y.Z${dev ? "-dev" : ""}, without leading zeros`);
  }
  return { dev_tag: `${base}-dev`, release_tag: `${base}-release` };
}

function execute(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

function tags(run) {
  // A successful list with no match means absent. Permission/network errors
  // must abort instead of being mistaken for permission to overwrite a tag.
  const entries = JSON.parse(
    run("gcloud", ["artifacts", "docker", "tags", "list", IMAGE, "--format=json"]),
  );
  if (!Array.isArray(entries)) throw new Error("Invalid registry tag list");
  return new Map(
    entries.map((entry) => {
      const tag = entry.tag?.split("/").at(-1);
      const digest = entry.version?.split("/").at(-1);
      if (!tag || !DIGEST.test(digest ?? "")) throw new Error("Invalid registry tag entry");
      return [tag, digest];
    }),
  );
}

function verify(tag, digest, run) {
  if (tags(run).get(tag) !== digest) throw new Error(`Registry digest mismatch for ${tag}`);
}

export function publish(input, run = execute) {
  const { dev_tag } = parseVersion(input);
  if (tags(run).has(dev_tag)) throw new Error(`${dev_tag} already exists; choose a new version`);
  const target = `${IMAGE}:${dev_tag}`;
  run("docker", ["tag", LOCAL_IMAGE, target]);
  run("docker", ["push", target]);
  const repoDigests = JSON.parse(
    run("docker", ["image", "inspect", target, "--format", "{{json .RepoDigests}}"]),
  );
  const digest = repoDigests.find((ref) => ref.startsWith(`${IMAGE}@`))?.split("@")[1];
  if (!DIGEST.test(digest ?? "")) throw new Error("Docker did not report a pushed digest");
  verify(dev_tag, digest, run);
  return { image: target, digest };
}

export function promote(input, run = execute) {
  const { dev_tag, release_tag } = parseVersion(input, true);
  const existing = tags(run);
  const digest = existing.get(dev_tag);
  if (!digest) throw new Error(`${dev_tag} does not exist`);
  const release = existing.get(release_tag);
  if (release && release !== digest)
    throw new Error(`${release_tag} already points at a different digest`);
  if (!release) {
    run("gcloud", [
      "artifacts",
      "docker",
      "tags",
      "add",
      `${IMAGE}@${digest}`,
      `${IMAGE}:${release_tag}`,
      "--quiet",
    ]);
  }
  verify(release_tag, digest, run);
  return { source: `${IMAGE}:${dev_tag}`, image: `${IMAGE}:${release_tag}`, digest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, input] = process.argv.slice(2);
    const actions = { version: parseVersion, publish, promote };
    if (!Object.hasOwn(actions, mode))
      throw new Error("Usage: writer-image.mjs version|publish|promote <version>");
    const result = actions[mode](input);
    console.log(JSON.stringify(result, null, 2));
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        Object.entries(result)
          .map(([key, value]) => `${key}=${value}\n`)
          .join(""),
      );
    }
    if (result.image && process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `Image: \`${result.image}\`\n\nDigest: \`${IMAGE}@${result.digest}\`\n`,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
