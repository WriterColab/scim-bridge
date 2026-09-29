"""Exercise the image with Writer's PostgreSQL and Kubernetes security settings."""

import base64
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request

image = sys.argv[1]
network = "scim-smoke-" + secrets.token_hex(4)
postgres = network + "-postgres"
app = network + "-app"
password = secrets.token_hex(20)


def run(args):
    return subprocess.check_output(args, text=True).strip()


def status(url, auth=None):
    request = urllib.request.Request(url)
    if auth:
        request.add_header("Authorization", "Basic " + base64.b64encode(auth.encode()).decode())
    try:
        with urllib.request.urlopen(request, timeout=4) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


try:
    run(["docker", "network", "create", network])
    run([
        "docker", "run", "-d", "--name", postgres, "--network", network,
        "-e", "POSTGRES_USER=smoke", "-e", "POSTGRES_PASSWORD=" + password,
        "-e", "POSTGRES_DB=scim_bridge", "postgres:16-alpine",
    ])
    for _ in range(60):
        result = subprocess.run(
            ["docker", "exec", postgres, "pg_isready", "-U", "smoke", "-d", "scim_bridge"],
            capture_output=True,
        )
        if result.returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError("PostgreSQL never became ready")

    run([
        "docker", "run", "-d", "--platform", "linux/amd64", "--name", app,
        "--network", network, "--user", "1000:1000", "--read-only",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "512m",
        "--tmpfs", "/tmp:rw,nosuid,nodev,uid=1000,gid=1000,size=256m",
        "-p", "127.0.0.1:0:8080", "-e", "APP_ROLE=bridge", "-e", "PORT=8080",
        "-e", "DATABASE_DRIVER=postgres",
        "-e", f"DATABASE_URL=postgresql://smoke:{password}@{postgres}:5432/scim_bridge",
        "-e", "PANEL_AUTH_USER=smoke", "-e", "PANEL_AUTH_PASSWORD=" + password,
        "-e", "APP_ENCRYPTION_KEY=" + secrets.token_hex(32),
        "-e", "PUBLIC_URL=http://localhost:8080", "-e", "DEMO_MODE=false",
        "-e", "PANEL_AUTH_DISABLED=false", "-e", "PANEL_CSRF_DISABLED=false",
        image, "node_modules/.bin/tsx", "server/index.ts",
    ])
    port = run(["docker", "port", app, "8080/tcp"]).split(":")[-1]
    base = "http://127.0.0.1:" + port
    for _ in range(90):
        if run(["docker", "inspect", "-f", "{{.State.Running}}", app]) != "true":
            raise RuntimeError("Application exited during startup")
        try:
            if status(base + "/healthz") == 200:
                break
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(1)
    else:
        raise RuntimeError("Application never became ready")

    for path, auth, expected in [
        ("/healthz", None, 200),
        ("/panel", None, 401),
        ("/panel", "smoke:wrong", 401),
        ("/panel", "smoke:" + password, 200),
        ("/scim/v2/Users", None, 401),
    ]:
        actual = status(base + path, auth)
        if actual != expected:
            raise RuntimeError(f"{path}: got {actual}, expected {expected}")
        print(f"PASS {path}: {actual}", flush=True)

    table = run([
        "docker", "exec", postgres, "psql", "-U", "smoke", "-d", "scim_bridge", "-Atc",
        "SELECT to_regclass('public.workos_primary_create_claims')",
    ])
    if table != "workos_primary_create_claims":
        raise RuntimeError("Durable create claims migration was not applied")
    print("PASS PostgreSQL migrations and Writer runtime settings", flush=True)
finally:
    logs = subprocess.run(["docker", "logs", app], capture_output=True, text=True)
    print((logs.stdout + logs.stderr).replace(password, "<redacted>")[-4500:], flush=True)
    for container in [app, postgres]:
        subprocess.run(["docker", "rm", "-f", "-v", container], capture_output=True)
    subprocess.run(["docker", "network", "rm", network], capture_output=True)
