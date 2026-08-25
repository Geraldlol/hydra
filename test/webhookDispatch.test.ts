import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type * as https from "node:https";
import { performance } from "node:perf_hooks";
import { Readable, Writable } from "node:stream";
import { describe, test } from "node:test";
import {
  dispatchPinnedHttpsWebhook,
  dispatchWebhookJson,
  isPublicWebhookAddress,
  UnsafeWebhookDestinationError,
  WEBHOOK_MAX_RESPONSE_BYTES,
  type HttpsRequestFactory,
  type PinnedWebhookLookup,
  type PinnedWebhookRequest,
  type WebhookDispatcher,
} from "../src/webhookDispatch";

function successfulDispatcher(inspect?: (request: PinnedWebhookRequest) => Promise<void> | void): WebhookDispatcher {
  return async (request) => {
    await inspect?.(request);
    return { ok: true, status: 204 };
  };
}

function pinnedAddress(request: PinnedWebhookRequest, hostname = request.hostname): Promise<{
  address: string;
  family: 4 | 6;
}> {
  return new Promise((resolve, reject) => {
    request.lookup(hostname, {}, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ address, family });
    });
  });
}

function fakeRequestFactory(
  statusCode: number,
  chunks: readonly Buffer[] = [],
  inspect?: (url: URL, options: https.RequestOptions) => void,
): HttpsRequestFactory {
  return (url, options, onResponse) => {
    inspect?.(url, options);
    const request = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }) as ClientRequest;
    request.once("finish", () => {
      queueMicrotask(() => {
        const response = Readable.from(chunks) as IncomingMessage;
        response.statusCode = statusCode;
        response.headers = {};
        onResponse(response);
      });
    });
    return request;
  };
}

describe("dispatchWebhookJson", () => {
  test("classifies public addresses and rejects special-use IPv4 and IPv6 ranges", () => {
    const blocked = [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.0.0.9",
      "192.0.2.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::ffff:8.8.8.8",
      "64:ff9b::808:808",
      "100::1",
      "2001::1",
      "2001:db8::1",
      "2002::1",
      "3fff::1",
      "fc00::1",
      "fe80::1",
      "ff02::1",
    ];
    for (const address of blocked) {
      assert.equal(isPublicWebhookAddress(address), false, `expected ${address} to be blocked`);
    }

    for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2001:4860:4860::8888", "2606:4700:4700::1111"]) {
      assert.equal(isPublicWebhookAddress(address), true, `expected ${address} to be public`);
    }
  });

  test("rejects a hostname whose DNS answer is private before dispatch", async () => {
    let dispatched = false;

    await assert.rejects(
      dispatchWebhookJson(new URL("https://hooks.example.test/decision"), { event: "test" }, {
        resolver: async () => [{ address: "10.20.30.40", family: 4 }],
        dispatcher: async () => {
          dispatched = true;
          return { ok: true, status: 204 };
        },
      }),
      UnsafeWebhookDestinationError,
    );
    assert.equal(dispatched, false);
  });

  test("rejects mixed public and private DNS answers instead of selecting the safe one", async () => {
    let dispatched = false;

    await assert.rejects(
      dispatchWebhookJson(new URL("https://hooks.example.test/decision"), { event: "test" }, {
        resolver: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "fd00::1", family: 6 },
        ],
        dispatcher: async () => {
          dispatched = true;
          return { ok: true, status: 204 };
        },
      }),
      UnsafeWebhookDestinationError,
    );
    assert.equal(dispatched, false);
  });

  test("pins dispatch to the vetted answer even if a later DNS answer would rebind", async () => {
    let resolverCalls = 0;

    const response = await dispatchWebhookJson(new URL("https://hooks.example.test/decision"), { event: "test" }, {
      resolver: async () => {
        resolverCalls += 1;
        return resolverCalls === 1
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "127.0.0.1", family: 4 }];
      },
      dispatcher: successfulDispatcher(async (request) => {
        assert.deepEqual(await pinnedAddress(request), { address: "93.184.216.34", family: 4 });
      }),
    });

    assert.deepEqual(response, { ok: true, status: 204 });
    assert.equal(resolverCalls, 1);
  });

  test("applies the webhook deadline to DNS resolution before any dispatch", async () => {
    let dispatched = false;
    const started = Date.now();

    await assert.rejects(
      dispatchWebhookJson(new URL("https://hooks.example.test/decision"), { event: "test" }, {
        timeoutMs: 20,
        resolver: () => new Promise<never>(() => undefined),
        dispatcher: async () => {
          dispatched = true;
          return { ok: true, status: 204 };
        },
      }),
      /DNS resolution timed out/i,
    );
    assert.equal(dispatched, false);
    assert.ok(Date.now() - started < 1_000, "the DNS deadline must settle promptly");
  });

  test("rejects a dispatcher success that settles after the absolute deadline", async () => {
    let dispatcherCalls = 0;

    await assert.rejects(
      dispatchWebhookJson(new URL("https://hooks.example.test/decision"), { event: "test" }, {
        timeoutMs: 10,
        resolver: async () => [{ address: "93.184.216.34", family: 4 }],
        dispatcher: async () => {
          dispatcherCalls += 1;
          const unblockAt = performance.now() + 25;
          while (performance.now() < unblockAt) {
            // Deliberately hold the event loop so the operation settles after
            // the deadline but before Node can run the overdue timer callback.
          }
          return { ok: true, status: 204 };
        },
      }),
      /dispatch timed out/i,
    );
    assert.equal(dispatcherCalls, 1);
  });

  test("rejects IPv4-mapped IPv6 and CGNAT literals without performing DNS", async () => {
    let resolverCalls = 0;
    const resolver = async () => {
      resolverCalls += 1;
      return [{ address: "93.184.216.34", family: 4 as const }];
    };

    for (const rawUrl of [
      "https://[::ffff:127.0.0.1]/decision",
      "https://[::ffff:8.8.8.8]/decision",
      "https://100.64.0.1/decision",
    ]) {
      await assert.rejects(
        dispatchWebhookJson(new URL(rawUrl), { event: "test" }, {
          resolver,
          dispatcher: successfulDispatcher(),
        }),
        UnsafeWebhookDestinationError,
        rawUrl,
      );
    }
    assert.equal(resolverCalls, 0);
  });

  test("dispatches a public IP literal without performing DNS", async () => {
    let resolverCalls = 0;

    const response = await dispatchWebhookJson(new URL("https://93.184.216.34/decision"), { event: "test" }, {
      resolver: async () => {
        resolverCalls += 1;
        throw new Error("literal IPs must not resolve through DNS");
      },
      dispatcher: successfulDispatcher((request) => {
        assert.equal(request.address, "93.184.216.34");
        assert.equal(request.family, 4);
      }),
    });

    assert.equal(response.status, 204);
    assert.equal(resolverCalls, 0);
  });

  test("uses a fresh pinned TLS request while preserving the hostname for SNI and certificates", async () => {
    let capturedOptions: https.RequestOptions | undefined;

    const response = await dispatchWebhookJson(new URL("https://hooks.example.test/decision"), { event: "test" }, {
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      dispatcher: (request) => dispatchPinnedHttpsWebhook(
        request,
        fakeRequestFactory(204, [], (_url, options) => {
          capturedOptions = options;
        }),
      ),
    });

    assert.deepEqual(response, { ok: true, status: 204 });
    assert.ok(capturedOptions);
    assert.equal(capturedOptions.agent, false);
    assert.equal(capturedOptions.family, 4);
    assert.equal(capturedOptions.servername, "hooks.example.test");
    assert.equal(capturedOptions.rejectUnauthorized, true);
    assert.equal(typeof capturedOptions.lookup, "function");

    const lookup = capturedOptions.lookup as unknown as PinnedWebhookLookup;
    const address = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup("hooks.example.test", {}, (error, pinned, family) => {
        if (error) {
          reject(error);
          return;
        }
        assert.equal(typeof pinned, "string");
        resolve({ address: pinned, family });
      });
    });
    assert.deepEqual(address, { address: "93.184.216.34", family: 4 });
  });

  test("the low-level dispatcher derives lookup from the validated address", async () => {
    let capturedOptions: https.RequestOptions | undefined;
    const request: PinnedWebhookRequest = {
      url: new URL("https://hooks.example.test/decision"),
      hostname: "hooks.example.test",
      address: "93.184.216.34",
      family: 4,
      lookup: (_hostname, _options, callback) => callback(null, "127.0.0.1", 4),
      body: "{}",
      timeoutMs: 10_000,
      deadline: performance.now() + 10_000,
      maxResponseBytes: WEBHOOK_MAX_RESPONSE_BYTES,
    };

    await dispatchPinnedHttpsWebhook(
      request,
      fakeRequestFactory(204, [], (_url, options) => {
        capturedOptions = options;
      }),
    );
    assert.ok(capturedOptions);
    const lookup = capturedOptions.lookup as unknown as PinnedWebhookLookup;
    const pinned = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup("hooks.example.test", {}, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address, family });
      });
    });
    assert.deepEqual(pinned, { address: "93.184.216.34", family: 4 });
  });

  test("destroys a pinned request whose response finishes after the absolute deadline", async () => {
    let destroyCalls = 0;
    const request: PinnedWebhookRequest = {
      url: new URL("https://hooks.example.test/decision"),
      hostname: "hooks.example.test",
      address: "93.184.216.34",
      family: 4,
      lookup: (_hostname, _options, callback) => callback(null, "93.184.216.34", 4),
      body: "{}",
      timeoutMs: 10,
      deadline: performance.now() + 10,
      maxResponseBytes: WEBHOOK_MAX_RESPONSE_BYTES,
    };
    const lateFactory: HttpsRequestFactory = (_url, _options, onResponse) => {
      const client = new EventEmitter() as ClientRequest;
      client.destroy = ((_error?: Error) => {
        destroyCalls += 1;
        return client;
      }) as ClientRequest["destroy"];
      client.end = (() => {
        const unblockAt = performance.now() + 25;
        while (performance.now() < unblockAt) {
          // Force response completion ahead of the overdue timers callback.
        }
        const response = new EventEmitter() as IncomingMessage;
        response.statusCode = 204;
        response.headers = {};
        response.destroy = (() => response) as IncomingMessage["destroy"];
        response.resume = (() => {
          response.emit("end");
          return response;
        }) as IncomingMessage["resume"];
        onResponse(response);
        return client;
      }) as ClientRequest["end"];
      return client;
    };

    await assert.rejects(dispatchPinnedHttpsWebhook(request, lateFactory), /request timed out/i);
    assert.equal(destroyCalls, 1);
  });

  test("rejects redirect responses", async () => {
    await assert.rejects(
      dispatchWebhookJson(new URL("https://hooks.example.test/decision"), { event: "test" }, {
        resolver: async () => [{ address: "93.184.216.34", family: 4 }],
        dispatcher: async () => ({ ok: false, status: 302 }),
      }),
      /redirect/i,
    );
  });

  test("aborts responses that exceed the bounded body cap", async () => {
    const request: PinnedWebhookRequest = {
      url: new URL("https://hooks.example.test/decision"),
      hostname: "hooks.example.test",
      address: "93.184.216.34",
      family: 4,
      lookup: (_hostname, _options, callback) => callback(null, "93.184.216.34", 4),
      body: "{}",
      timeoutMs: 10_000,
      deadline: performance.now() + 10_000,
      maxResponseBytes: WEBHOOK_MAX_RESPONSE_BYTES,
    };

    await assert.rejects(
      dispatchPinnedHttpsWebhook(
        request,
        fakeRequestFactory(200, [Buffer.alloc(WEBHOOK_MAX_RESPONSE_BYTES + 1)]),
      ),
      /response body exceeded/i,
    );
  });
});
