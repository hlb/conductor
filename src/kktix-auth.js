import { readFile, stat } from "node:fs/promises";

const COOKIE_DOMAIN = ".kktix.com";

export function parseCookieHeader(input) {
  const value = String(input ?? "").trim().replace(/^cookie\s*:\s*/i, "");
  if (!value) {
    throw new Error("Cookie 是空的。請用 --cookie-stdin、--cookie-file 或 KKTIX_COOKIE 提供登入後的 Cookie header。");
  }

  const cookies = value
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf("=");
      if (separator <= 0) {
        throw new Error(`Cookie 片段格式不正確：${part.slice(0, 40)}`);
      }

      const cookie = {
        name: part.slice(0, separator).trim(),
        value: part.slice(separator + 1).trim(),
        secure: true,
      };
      return cookie.name.startsWith("__Host-")
        ? { ...cookie, url: "https://kktix.com" }
        : { ...cookie, domain: COOKIE_DOMAIN, path: "/" };
    });

  const unique = new Map();
  for (const cookie of cookies) unique.set(cookie.name, cookie);
  return [...unique.values()];
}

export async function readCookieInput(options, stdin = process.stdin) {
  if (options.cookieStdin) {
    if (stdin.isTTY) {
      throw new Error("--cookie-stdin 需要從標準輸入傳入 Cookie，例如：pbpaste | npm run conductor -- kktix events --cookie-stdin");
    }
    return readAll(stdin);
  }

  if (options.cookieFile) {
    await warnIfCookieFileIsBroadlyReadable(options.cookieFile);
    return readFile(options.cookieFile, "utf8");
  }

  if (process.env.KKTIX_COOKIE) return process.env.KKTIX_COOKIE;

  throw new Error("找不到 Cookie。建議使用：pbpaste | npm run conductor -- kktix events --cookie-stdin");
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function warnIfCookieFileIsBroadlyReadable(path) {
  if (process.platform === "win32") return;
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) {
    process.stderr.write(`警告：Cookie 檔案 ${path} 可被其他使用者讀取；建議執行 chmod 600。\n`);
  }
}
