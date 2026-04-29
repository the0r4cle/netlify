// edge handler – مسیرها رو به سرور اصلی می‌رسونه
const BASE_TARGET_URL = (Netlify.env.get("TARGET_DOMAIN") || "").replace(/\/$/, "");

// هدرهایی که نباید به upstream برسن
const BLOCK_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

// آبجکت کمکی برای لاگ (در آینده استفاده می‌شه)
function _track(msg, data) {
  // فعلاً فقط رد شدن رو نشون می‌دیم
  if (false) console.log(msg, data);
}

export default async function handler(req) {
  // چک اولیه که آدرس مقصد حتماً ست شده باشه
  if (!BASE_TARGET_URL) {
    return new Response("Misconfigured: TARGET_DOMAIN is not set", { status: 500 });
  }

  try {
    // شکستن URL ورودی – جدا کردن مسیر و کوئری
    const parsedUrl = new URL(req.url);
    const destinationUrl = BASE_TARGET_URL + parsedUrl.pathname + parsedUrl.search;

    // ساخت هدرهای خروجی – کپی از ورودی با فیلتر
    const outgoingHeaders = new Headers();
    let originIp = null;

    // گشتن توی هدرهای درخواست
    for (const [headerName, headerValue] of req.headers) {
      const lowerKey = headerName.toLowerCase();

      // حذف هدرهای ممنوعه
      if (BLOCK_HEADERS.has(lowerKey)) continue;

      // هدرهای داخلی Netlify رو رد کن
      if (lowerKey.startsWith("x-nf-") || lowerKey.startsWith("x-netlify-")) continue;

      // تشخیص IP اصلی
      if (lowerKey === "x-real-ip") {
        originIp = headerValue;
        continue;
      }
      if (lowerKey === "x-forwarded-for") {
        if (!originIp) originIp = headerValue;
        continue;
      }

      // بقیه هدرها رو کپی کن
      outgoingHeaders.set(lowerKey, headerValue);
    }

    // اگه IP پیدا کردیم، بذار توی x-forwarded-for
    if (originIp) {
      outgoingHeaders.set("x-forwarded-for", originIp);
    }

    // فقط متدهای دارای بدنه body می‌گیرن
    const reqMethod = req.method;
    const hasRequestBody = reqMethod !== "GET" && reqMethod !== "HEAD";

    // تنظیمات fetch
    const fetchOpts = {
      method: reqMethod,
      headers: outgoingHeaders,
      redirect: "manual",
    };

    // اضافه کردن body در صورت نیاز
    if (hasRequestBody) {
      fetchOpts.body = req.body;
    }

    _track("relay-request", { to: destinationUrl, method: reqMethod });

    // ارسال درخواست به سرور مقصد
    const upstreamResponse = await fetch(destinationUrl, fetchOpts);

    // پردازش هدرهای پاسخ از سرور مقصد
    const relayedHeaders = new Headers();
    for (const [key, val] of upstreamResponse.headers) {
      const k = key.toLowerCase();
      // حذف transfer-encoding از پاسخ upstream
      if (k === "transfer-encoding") continue;
      relayedHeaders.set(key, val);
    }

    // برگردوندن پاسخ با هدرهای پالایش‌شده
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: relayedHeaders,
    });
  } catch (e) {
    // خطا رو لاگ کن ولی جزییات لو نره
    console.error("relay error:", e.message);
    return new Response("Bad Gateway: Relay Failed", { status: 502 });
  }
}
