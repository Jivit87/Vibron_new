import { describe, expect, it } from "vitest";
import * as devServerUrl from "../electron/dev-server-url.js";

describe("getDevServerUrl", () => {
  it("uses the URL supplied by the desktop launcher", () => {
    expect(devServerUrl.getDevServerUrl({ VIBERON_DEV_SERVER_URL: "http://127.0.0.1:4317" }))
      .toBe("http://127.0.0.1:4317");
  });
});
