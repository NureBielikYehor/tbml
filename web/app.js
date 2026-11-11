import { Contract, JsonRpcProvider, formatEther, parseEther } from "/vendor/ethers.js";

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const amount = value => new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 6 }).format(Number(formatEther(value || "0")));
const states = ["Чернетка", "Збір коштів", "Виконання", "Голосування", "Завершено", "Повернення"];
let config, campaigns = [], filter = "all", activeAddress, catalog, clock = 0, busy = false;
const rpc = new JsonRpcProvider(`${location.origin}/rpc`, undefined, { cacheTimeout: -1 });
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Помилка запиту");
  return value;
}
function toast(message) {
  const node = $("#toast"), parent = document.querySelector("dialog[open]") || document.body;
  if (node.parentElement !== parent) parent.append(node);
  node.textContent = message; node.hidden = false; clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.hidden = true, 9000);
}
async function task(work) {
  if (busy) return;
  busy = true;
  $("#account").disabled = true;
  const buttons = [...document.querySelectorAll("button")]; buttons.forEach(button => button.disabled = true);
  try { return await work(); }
  catch (error) { console.error(error); toast(error.shortMessage || error.message || "Операцію не виконано"); }
  finally { busy = false; $("#account").disabled = false; buttons.forEach(button => button.disabled = false); }
}
function account() { return $("#account").value; }
async function campaign(address) { return new Contract(address, config.abi.Campaign, await rpc.getSigner(account())); }
async function transact(contract, name, ...args) {
  toast("Підтвердження транзакції…"); const tx = await contract[name](...args); await tx.wait(); toast("Транзакцію підтверджено");
}
async function refresh() {
  const result = await api("/api/campaigns"); campaigns = result.campaigns; clock = result.blockTime;
  renderCards();
  if (activeAddress && $("#detail-dialog").open) await detail(activeAddress);
}
function renderCards() {
  const list = campaigns.filter(item => filter === "all" || filter === "active" && [2, 3].includes(item.state) || String(item.state) === filter);
  $("#campaign-list").innerHTML = list.length ? list.map(item => `<button class="card" data-address="${item.address}">
    <div class="card-banner"><span class="category">${escape(item.metadata.main_category)}</span><span class="badge">${states[item.state]}</span></div>
    <div class="card-body"><h3>${escape(item.metadata.title)}</h3><p class="description">${escape(item.metadata.description)}</p>
    <div class="money"><b>${amount(item.total)} ETH</b><span>ціль ${amount(item.goal)} ETH</span></div>
    <progress value="${Number(item.total) / Number(item.goal)}" max="1"></progress><div class="card-foot"><span class="score">${item.prediction ? `Прогноз ${(item.prediction.scoreBps / 100).toFixed(1)}%` : "Очікує прогнозу"}</span><span>${item.milestones.length} етапи ↗</span></div></div></button>`).join("") :
    `<div class="empty">${campaigns.length ? "У цій категорії ще немає кампаній." : "Тут починається ваша перша кампанія.<br>Створіть її, отримайте прогноз і відкрийте збір."}</div>`;
  document.querySelectorAll("[data-address]").forEach(node => node.addEventListener("click", () => task(() => detail(node.dataset.address))));
}
async function detail(address) {
  activeAddress = address;
  const item = await api(`/api/campaigns/${address}`), c = await campaign(address);
  const own = item.author.toLowerCase() === account().toLowerCase();
  const contribution = await c.contributions(account());
  const claimed = await c.refundClaimed(account());
  const voted = item.state === 3 ? await c.hasVoted(item.currentMilestone, account()) : false;
  const prediction = item.prediction;
  const current = item.milestones[item.currentMilestone];
  const actions = [];
  if (item.state === 0) {
    actions.push(`<button class="quiet" data-action="score">Отримати прогноз моделі</button>`);
    if (own && prediction) actions.push(`<button class="primary" data-action="startFunding">Відкрити збір ↗</button>`);
    if (own) actions.push(`<button class="quiet" data-action="cancelDraft">Скасувати чернетку</button>`);
  }
  if (item.state === 1 && !own && clock < Number(item.fundingDeadline)) actions.push(`<form id="contribution-form"><label>Ваш внесок, тестовий ETH<input name="amount" type="number" min="0.000000001" max="${formatEther(BigInt(item.goal) - BigInt(item.total))}" step="any" value="${formatEther((BigInt(item.goal) - BigInt(item.total)) / 2n)}" required></label><button class="primary" type="submit">Підтримати кампанію ↗</button></form>`);
  if (item.state === 1 && clock >= Number(item.fundingDeadline)) actions.push(`<button class="quiet" data-action="finalizeFunding">Закрити збір та відкрити повернення</button>`);
  if (item.state === 2 && own && clock < Number(item.submissionDeadline)) actions.push(`<form id="report-form"><label>Звіт за етап<textarea name="body" required minlength="10" rows="4" placeholder="Що виконано? Додайте результати, посилання та пояснення для вкладників."></textarea></label><button class="primary" type="submit">Подати звіт на голосування ↗</button></form>`);
  if (item.state === 2 && clock >= Number(item.submissionDeadline)) actions.push(`<button class="quiet" data-action="expireSubmission">Строк звіту минув — відкрити повернення</button>`);
  if (item.state === 3) {
    if (contribution > 0n && !voted && clock < Number(current.voteDeadline)) actions.push(`<button class="primary" data-vote="true">Схвалити етап</button><button class="danger" data-vote="false">Відхилити етап</button>`);
    if (clock >= Number(current.voteDeadline)) actions.push(`<button class="primary" data-action="finalizeMilestone">Підбити підсумки голосування</button>`);
    else actions.push(`<button class="quiet" id="advance">Локальне демо: завершити час голосування</button>`);
    if (voted) actions.push(`<p class="hint">Ваш голос уже зараховано. Вага: ${amount(contribution.toString())} ETH.</p>`);
  }
  if (own && BigInt(item.authorCredit) > 0n) actions.push(`<button class="primary" data-action="withdrawPayout">Отримати схвалений транш: ${amount(item.authorCredit)} ETH</button>`);
  if (item.state === 5 && contribution > 0n && !claimed) actions.push(`<button class="primary" data-action="claimRefund">Забрати повернення: ${amount((await c.refundable(account())).toString())} ETH</button>`);
  if (claimed) actions.push(`<p class="hint">Повернення за вашим внеском уже отримано.</p>`);
  $("#detail").innerHTML = `<span class="badge">${states[item.state]}</span><h2 class="detail-title">${escape(item.metadata.title)}</h2><p class="detail-description">${escape(item.metadata.description)}</p>
    <div class="detail-metrics"><div><small>Зібрано / ціль</small><b>${amount(item.total)} / ${amount(item.goal)} ETH</b></div><div><small>Прогноз збору</small><b>${prediction ? (prediction.scoreBps / 100).toFixed(1) + "%" : "Ще немає"}</b></div><div><small>Ваш внесок</small><b>${amount(contribution.toString())} ETH</b></div></div>
    <p class="hint">Голоси зважені за внесками. Кворум — 50% зібраної суми, схвалення — більше голосів «за», ніж «проти». Нічия або відсутність кворуму відкриває повернення.</p>
    ${item.milestones.map((m, i) => `<section class="stage"><h4>${i + 1}. ${escape(item.metadata.milestoneTitles?.[i] || "Етап")} · ${amount(m.amount)} ETH</h4><p>${["Очікує звіту", "Голосування", "Схвалено", "Відхилено"][m.status]}${m.status === 1 ? ` · за ${amount(m.yesWeight)} / проти ${amount(m.noWeight)} ETH · до ${new Date(Number(m.voteDeadline) * 1000).toLocaleString("uk-UA")}` : ""}</p>${m.reportHash !== "0x" + "0".repeat(64) ? `<button class="quiet" data-report="${m.reportHash}">Прочитати звіт</button><div class="report-text" id="report-${i}"></div>` : ""}</section>`).join("")}
    <div class="actions">${actions.join("")}</div><div class="audit">Автор: ${escape(item.author)}<br>Контракт: ${escape(address)}<br><a href="/api/content/${item.metadataHash}" target="_blank" rel="noopener">Незмінні вхідні дані та параметри</a>${prediction ? `<br>Модель: ${escape(prediction.modelHash)}<br><a href="/api/content/${prediction.auditHash}" target="_blank" rel="noopener">Аудит прогнозу</a>` : ""}</div>`;
  if (!$("#detail-dialog").open) $("#detail-dialog").showModal();
  document.querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", () => task(async () => {
    const action = button.dataset.action;
    if (action === "score") { toast("Обчислення прогнозу та запис у реєстр…"); await api(`/api/campaigns/${address}/score`, {}); }
    else await transact(c, action, ...(["withdrawPayout", "claimRefund"].includes(action) ? [account()] : []));
    await refresh();
  })));
  document.querySelectorAll("[data-vote]").forEach(button => button.addEventListener("click", () => task(async () => { await transact(c, "vote", button.dataset.vote === "true"); await refresh(); })));
  document.querySelectorAll("[data-report]").forEach(button => button.addEventListener("click", () => task(async () => { const value = await api(`/api/content/${button.dataset.report}`); button.nextElementSibling.textContent = value.body; })));
  $("#advance")?.addEventListener("click", () => task(async () => { await api("/api/dev/advance", { seconds: Number(current.voteDeadline) - clock + 1 }); await refresh(); }));
  $("#contribution-form")?.addEventListener("submit", event => { event.preventDefault(); task(async () => { const value = new FormData(event.target).get("amount"); await transact(c, "contribute", { value: parseEther(value) }); await refresh(); }); });
  $("#report-form")?.addEventListener("submit", event => { event.preventDefault(); task(async () => { const report = await api("/api/reports", { body: new FormData(event.target).get("body") }); await transact(c, "submitReport", report.hash); await refresh(); }); });
}

$("#open-create").addEventListener("click", () => $("#create-dialog").showModal());
document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => { $(`#${button.dataset.close}`).close(); if (button.dataset.close === "detail-dialog") activeAddress = null; }));
$("#detail-dialog").addEventListener("close", () => activeAddress = null);
$("#refresh").addEventListener("click", () => task(refresh));
$("#account").addEventListener("change", () => task(refresh));
$("#filters").addEventListener("click", event => { const button = event.target.closest("[data-filter]"); if (!button) return; filter = button.dataset.filter; document.querySelectorAll("[data-filter]").forEach(node => node.classList.toggle("active", node === button)); renderCards(); });
$("#create-form").addEventListener("submit", event => {
  event.preventDefault(); task(async () => {
    const values = Object.fromEntries(new FormData(event.target));
    const selectedCategory = catalog.categories.find(item => item.category === values.category);
    const saved = await api("/api/metadata", { ...values, main_category: selectedCategory.main_category,
      milestoneBps: [Number(values.firstPercent) * 100, 10000 - Number(values.firstPercent) * 100],
      milestoneTitles: [values.firstTitle, values.secondTitle] });
    const f = new Contract(config.factory, config.abi.CampaignFactory, await rpc.getSigner(account()));
    const m = saved.metadata;
    await transact(f, "createCampaign", saved.hash, m.goalWei, m.fundingDeadline, m.votingDuration, m.submissionWindow, m.milestoneBps);
    $("#create-dialog").close(); await refresh();
    await detail(await f.campaigns((await f.campaignCount()) - 1n));
  });
});
async function init() {
  config = await api("/api/config"); clock = config.blockTime;
  const labels = ["Адміністратор", "Автор", "Вкладник A", "Вкладник B"];
  $("#account").innerHTML = config.accounts.slice(0, 4).map((address, index) => `<option value="${address}" ${index === 1 ? "selected" : ""}>${labels[index]} · ${address.slice(0, 6)}…</option>`).join("");
  $("#network").textContent = "● Local · 31337";
  catalog = await api("/api/catalog");
  $("#category").innerHTML = catalog.categories.map(item => `<option value="${escape(item.category)}">${escape(item.main_category)} / ${escape(item.category)}</option>`).join("");
  for (const [selector, key, selected] of [["#currency", "currencies", "USD"], ["#country", "countries", "US"]]) {
    $(selector).innerHTML = catalog[key].map(value => `<option ${value === selected ? "selected" : ""}>${escape(value)}</option>`).join("");
  }
  async function modelStatus(attempt = 0) {
    try {
      const model = await api("/api/model"), metrics = model.metrics[model.selected].test;
      $("#model-status").textContent = `${model.usesDescription ? "Текст + числові ознаки" : "Числовий прототип"} · ROC-AUC ${metrics.roc_auc.toFixed(3)} · історичний тест. Прогноз збору, а не гарантія виконання.`;
    } catch {
      $("#model-status").textContent = "Модель завантажується або потребує навчання. Чернетки доступні; збір відкриється після прогнозу.";
      if (attempt < 20) setTimeout(() => modelStatus(attempt + 1), 1000);
    }
  }
  modelStatus();
  await refresh();
}
init().catch(error => { $("#campaign-list").textContent = "Сервіс недоступний. Перевірте запуск npm run dev."; toast(error.message); });
