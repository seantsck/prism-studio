import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UnsafeUrlError, assertSafeUrl, isPublicIp, safeFetch } from "../safe-fetch";

describe("isPublicIp", () => {
  it("accepts ordinary public addresses", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "2606:4700:4700::1111",
      "2a00:1450:4001:81b::200e",
    ]) {
      expect(isPublicIp(ip), ip).toBe(true);
    }
  });

  it("refuses loopback, private, link-local, metadata, CGNAT, multicast and reserved ranges", () => {
    const bad = [
      "127.0.0.1",
      "127.8.8.8",
      "0.0.0.0",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "198.18.0.1",
      "192.0.2.10",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:7f00:1",
      "2002:7f00:1::",
      "64:ff9b::a00:1",
      "not-an-ip",
      "",
    ];
    for (const ip of bad) expect(isPublicIp(ip), ip).toBe(false);
  });

  it("does not misclassify neighbours of the private ranges", () => {
    for (const ip of [
      "172.15.0.1",
      "172.32.0.1",
      "192.167.0.1",
      "100.63.255.255",
      "100.128.0.1",
      "169.253.0.1",
    ]) {
      expect(isPublicIp(ip), ip).toBe(true);
    }
  });
});

describe("assertSafeUrl", () => {
  const policy = { allowedHosts: ["cdn.provider.example", "*.media.provider.example"] };

  it("accepts https URLs on allow-listed hosts only", () => {
    expect(assertSafeUrl("https://cdn.provider.example/out.mp4?sig=abc", policy).hostname).toBe(
      "cdn.provider.example",
    );
    expect(assertSafeUrl("https://eu.media.provider.example/x", policy).hostname).toBe(
      "eu.media.provider.example",
    );
  });

  it("refuses everything else", () => {
    const cases: Array<[string, string]> = [
      ["http://cdn.provider.example/x", "scheme"],
      ["file:///etc/passwd", "scheme"],
      ["ftp://cdn.provider.example/x", "scheme"],
      ["data:image/png;base64,AAAA", "scheme"],
      ["javascript:alert(1)", "scheme"],
      ["https://user:pw@cdn.provider.example/x", "credentials"],
      ["https://cdn.provider.example:8443/x", "port"],
      ["https://evil.example/x", "host_not_allowed"],
      ["https://cdn.provider.example.evil.example/x", "host_not_allowed"],
      ["https://media.provider.example/x", "host_not_allowed"], // wildcard needs a subdomain
      ["https://169.254.169.254/latest/meta-data", "host_not_allowed"],
      ["not a url", "bad_url"],
    ];
    for (const [url, code] of cases) {
      try {
        assertSafeUrl(url, policy);
        throw new Error(`accepted ${url}`);
      } catch (e) {
        expect(e).toBeInstanceOf(UnsafeUrlError);
        expect((e as UnsafeUrlError).code, url).toBe(code);
      }
    }
  });

  it("an empty allow-list refuses every URL (adapters must opt in)", () => {
    expect(() => assertSafeUrl("https://cdn.provider.example/x", { allowedHosts: [] })).toThrow(
      UnsafeUrlError,
    );
  });

  it("a private IP literal is refused even when someone put it on the allow-list", () => {
    expect(() => assertSafeUrl("https://10.0.0.1/x", { allowedHosts: ["10.0.0.1"] })).toThrow(/non-public/);
  });
});

describe("safeFetch against a local server (loopback allowed for tests only)", () => {
  let server: http.Server;
  let base = "";
  const limits = { maxBytes: 1024, timeoutMs: 1500, maxRedirects: 2 };
  const policy = { allowedHosts: [], unsafeAllowLoopbackHttp: true };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.alloc(100, 1));
      } else if (req.url === "/big") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.alloc(5000, 2));
      } else if (req.url === "/stream-big") {
        res.writeHead(200);
        res.write(Buffer.alloc(900));
        setTimeout(() => res.end(Buffer.alloc(900)), 20);
      } else if (req.url === "/redirect-ok") {
        res.writeHead(302, { location: "/ok" });
        res.end();
      } else if (req.url === "/redirect-metadata") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
        res.end();
      } else if (req.url === "/loop") {
        res.writeHead(302, { location: "/loop" });
        res.end();
      } else if (req.url === "/slow") {
        setTimeout(() => res.end("late"), 5000).unref();
      } else if (req.url === "/trickle") {
        // One byte every 30 ms: never idle, never over the byte cap: only an overall deadline stops it.
        res.writeHead(200);
        const t = setInterval(() => res.write("x"), 30);
        res.on("close", () => clearInterval(t));
      } else if (req.url === "/500") {
        res.writeHead(500);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("downloads small bodies and reports the host, not the URL", async () => {
    const out = await safeFetch(`${base}/ok`, policy, limits);
    expect(out.bytes.length).toBe(100);
    expect(out.contentType).toBe("image/png");
    expect(out.host).toBe("127.0.0.1");
  });

  it("enforces the byte cap from content-length and while streaming", async () => {
    await expect(safeFetch(`${base}/big`, policy, limits)).rejects.toMatchObject({ code: "too_large" });
    await expect(safeFetch(`${base}/stream-big`, policy, limits)).rejects.toMatchObject({
      code: "too_large",
    });
  });

  it("follows bounded redirects and refuses redirects into non-public space", async () => {
    expect((await safeFetch(`${base}/redirect-ok`, policy, limits)).redirects).toBe(1);
    await expect(safeFetch(`${base}/redirect-metadata`, policy, limits)).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    await expect(safeFetch(`${base}/loop`, policy, limits)).rejects.toMatchObject({
      code: "too_many_redirects",
    });
  });

  it("times out and maps HTTP errors", async () => {
    await expect(safeFetch(`${base}/slow`, policy, { ...limits, timeoutMs: 200 })).rejects.toMatchObject({
      code: "timeout",
    });
    await expect(safeFetch(`${base}/500`, policy, limits)).rejects.toMatchObject({ code: "http_error" });
  });

  it("an overall deadline stops a slow trickle that never hits the idle timeout", async () => {
    const started = Date.now();
    await expect(
      safeFetch(`${base}/trickle`, policy, { maxBytes: 1_000_000, timeoutMs: 400, maxRedirects: 1 }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("without the test override, loopback is refused at the URL policy", async () => {
    await expect(safeFetch(`${base}/ok`, { allowedHosts: [] }, limits)).rejects.toMatchObject({
      code: "scheme",
    });
  });
});
