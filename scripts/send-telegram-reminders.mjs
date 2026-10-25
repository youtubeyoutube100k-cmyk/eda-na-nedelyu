import process from "node:process";

const required = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "FAMILY_CODE", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.log("Telegram sender is not configured yet. Add these GitHub Actions secrets: " + missing.join(", "));
  process.exit(0);
}

const zone = "Asia/Tashkent";
const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  .formatToParts(new Date()).reduce((obj, part) => { if (part.type !== "literal") obj[part.type] = part.value; return obj; }, {});
const date = `${parts.year}-${parts.month}-${parts.day}`;
const time = `${parts.hour}:${parts.minute}`;
const dayIndex = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
const dayNames = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];

async function rpc(name, body) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, "");
  const response = await fetch(`${base}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Supabase RPC ${name} failed (${response.status})`);
  return response.json();
}

const state = await rpc("get_family_state", { p_code: process.env.FAMILY_CODE });
const times = [...new Set(Array.isArray(state?.notificationTimes) ? state.notificationTimes : ["08:30"])].sort();
const currentMinute = Number(parts.hour) * 60 + Number(parts.minute);
const dueTimes = times.filter((candidate) => {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(candidate)) return false;
  const [hour, minute] = candidate.split(":").map(Number);
  const elapsed = currentMinute - (hour * 60 + minute);
  return elapsed >= 0 && elapsed <= 5;
});
if (!dueTimes.length) {
  console.log(`No reminder due at ${time} (${zone}); configured times: ${times.join(", ") || "none"}.`);
  process.exit(0);
}
const menu = Array.isArray(state?.menu) ? state.menu : [];
const todaysMeals = Array.isArray(menu[dayIndex]) ? menu[dayIndex] : [];
const checked = Array.isArray(state?.checked) ? state.checked : [];
const groceries = Array.isArray(state?.groceries) ? state.groceries : [];
const mealLines = todaysMeals.length
  ? todaysMeals.map((meal) => `• ${meal?.name || "Блюдо"}${Number.isFinite(Number(meal?.price)) ? ` — ${new Intl.NumberFormat("ru-RU").format(Number(meal.price))} сум` : ""}`).join("\n")
  : "Меню пока не настроено в облачной базе.";
const todo = groceries.map((item, index) => ({ name: typeof item === "string" ? item : (item?.ru || item?.name || "Продукт"), index }))
  .filter((item) => !checked.includes(item.index)).map((item) => `• ${item.name}`);


async function sendDailyPoll() {
  const pollSlot = `${date}_daily_poll`;
  const claimed = await rpc("claim_family_notification", { p_code: process.env.FAMILY_CODE, p_slot: pollSlot });
  if (claimed !== true) {
    console.log(`Today's Telegram food poll already sent or claimed: ${pollSlot}.`);
    return;
  }

  const pollOptions = [...new Set(todaysMeals.map((meal) => String(meal?.name || "").trim()).filter(Boolean))].slice(0, 10);
  if (pollOptions.length < 2) {
    pollOptions.splice(0, pollOptions.length, "🍲 Борщ", "🍛 Плов", "🍗 Курица с рисом", "🍔 Бургеры");
  }

  try {
    const tg = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPoll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        question: "🍽️ Что будем есть сегодня?",
        options: pollOptions,
        is_anonymous: false,
        allows_multiple_answers: false
      })
    });
    const result = await tg.json();
    if (!tg.ok || result.ok !== true) throw new Error("Telegram rejected the daily food poll. Check the bot token and group chat ID.");
    console.log(`Daily food poll sent for ${date}.`);
  } catch (error) {
    await rpc("release_family_notification", { p_code: process.env.FAMILY_CODE, p_slot: pollSlot }).catch(() => {});
    throw error;
  }
}

for (const reminderTime of dueTimes) {
  const slot = `${date}_${reminderTime}`;
  const claimed = await rpc("claim_family_notification", { p_code: process.env.FAMILY_CODE, p_slot: slot });
  if (claimed !== true) {
    console.log(`Reminder ${slot} already sent or claimed.`);
    continue;
  }
  const message = `🍲 Еда на неделю\n${dayNames[dayIndex]}, ${date}\n\n📅 Меню на сегодня:\n${mealLines}\n\n🛒 Осталось купить:\n${todo.length ? todo.join("\n") : "Всё отмечено как купленное."}\n\n⏰ Напоминание в ${reminderTime} (Ташкент)`;
  try {
    const tg = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: message })
    });
    const result = await tg.json();
    if (!tg.ok || result.ok !== true) throw new Error("Telegram rejected the reminder. Check the bot token and chat ID in repository secrets.");
    console.log(`Telegram reminder sent for ${slot}.`);
  } catch (error) {
    await rpc("release_family_notification", { p_code: process.env.FAMILY_CODE, p_slot: slot }).catch(() => {});
    throw error;
  }
}

// Publish one family food poll per day, at the first configured reminder time.
if (dueTimes.length) await sendDailyPoll();
