#!/usr/bin/env node
/**
 * CLI that drives the Star Health AtomPro "Get Quote" (guest) flow:
 *   https://atompro.starhealth.in/sso/login -> Get Quote -> pincode
 *   -> quick quote form -> product recommendations
 *
 * Live-scrapes every catalog-style dropdown (Product, member counts, ages,
 * Sum Insured, Policy Period) from the real page at the moment it's needed,
 * instead of hardcoding option lists — those lists change over time on the
 * site, so hardcoding them would silently go stale.
 *
 * IMPORTANT: AtomPro sits behind Akamai bot protection, which returns
 * "Access Denied" (403) to a freshly-launched, fingerprint-detectable
 * automated browser (headless or headful). This CLI therefore does NOT
 * launch its own browser. Instead it attaches (via Chrome DevTools
 * Protocol) to a real Chrome window that YOU open and are already using -
 * the exact same approach a human browsing the site would take, just
 * remote-controlled. No fingerprint spoofing or anti-bot bypass code is
 * used or attempted.
 *
 * Setup (one-time per session):
 *   1. Fully quit Chrome.
 *   2. Relaunch it with remote debugging enabled, e.g. on Windows:
 *        "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
 *   3. Leave that Chrome window open. Run this CLI - it will attach to it,
 *      open a new tab, and drive the flow there.
 *
 * NOTE: This automates the live web UI (no public API is used), so if
 * Star Health changes the AtomPro front-end, the selectors below may need
 * updating.
 */

import { chromium } from "playwright-core";
import prompts from "prompts";

const LOGIN_URL = "https://atompro.starhealth.in/sso/login";
const CDP_ENDPOINT = process.env.CDP_ENDPOINT || "http://localhost:9222";

async function connect(endpoint = CDP_ENDPOINT) {
  console.log(`\nAttaching to your Chrome at ${endpoint} ...`);
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint);
  } catch (err) {
    console.error(
      `\nCould not connect to Chrome at ${endpoint}.\n` +
        `Make sure Chrome is fully closed and relaunched with:\n` +
        `  chrome.exe --remote-debugging-port=9222\n` +
        `then try again.\n`
    );
    throw err;
  }
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await context.newPage();
  return { browser, page };
}

async function fieldExists(page, muiId, nth = 0) {
  return (await page.locator(`[id="mui-component-select-${muiId}"]`).count()) > nth;
}

/** Open a MUI select (by id, optionally the nth one on the page), read its
 * live option texts, then close it again without changing the value. */
async function scrapeSelectOptions(page, muiId, nth = 0) {
  const combobox = page.locator(`[id="mui-component-select-${muiId}"]`).nth(nth);
  await combobox.scrollIntoViewIfNeeded();
  let options = [];
  for (let attempt = 0; attempt < 4 && options.length === 0; attempt++) {
    await combobox.click({ force: true });
    await page.waitForTimeout(200);
    options = await page.getByRole("option").allTextContents();
    if (options.length === 0) await page.waitForTimeout(300);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  if (options.length === 0) {
    throw new Error(
      `Could not read any options for #mui-component-select-${muiId} (nth=${nth}) — the dropdown never opened after several attempts.`
    );
  }
  return options;
}

/** Find the [role="option"] element whose exact textContent (trimmed) equals
 * `text`. getByRole's accessible-name matching inserts implicit spaces
 * between child elements (e.g. "Super Star Trending"), which doesn't match
 * the raw textContent we scraped ("Super StarTrending") — so we compare
 * textContent directly instead. */
async function findOptionByExactText(page, text) {
  const options = page.getByRole("option");
  const count = await options.count();
  for (let i = 0; i < count; i++) {
    const t = (await options.nth(i).textContent()).trim();
    if (t === text) return options.nth(i);
  }
  return null;
}

/** Open a MUI select (by id, optionally the nth one) and click the option
 * with the given exact text. Verifies the value actually stuck afterwards
 * (a click can silently miss its target on a busy/re-rendering page) and
 * retries the whole open-select-verify cycle if not. */
async function applySelectOption(page, muiId, valueText, nth = 0) {
  const combobox = page.locator(`[id="mui-component-select-${muiId}"]`).nth(nth);
  await combobox.scrollIntoViewIfNeeded();

  for (let cycle = 0; cycle < 3; cycle++) {
    let option = null;
    for (let attempt = 0; attempt < 3 && !option; attempt++) {
      await combobox.click({ force: true });
      await page.waitForTimeout(200);
      option = await findOptionByExactText(page, valueText);
      if (!option) await page.waitForTimeout(200);
    }
    if (!option) {
      const visible = await page.getByRole("option").allTextContents();
      console.error(
        `Could not find option "${valueText}" for #mui-component-select-${muiId} (nth=${nth}). Currently visible options: ${JSON.stringify(visible)}`
      );
      throw new Error(`Option "${valueText}" not found for #mui-component-select-${muiId}`);
    }
    await option.click();
    await page.waitForTimeout(200);

    // The closed combobox shows just the plain value (e.g. "Super Star"),
    // without any badge suffix that was part of the option text (e.g.
    // "Super StarTrending") — so accept an exact match or a prefix match.
    const currentText = (await combobox.textContent()).trim();
    const matches =
      currentText.length > 0 &&
      (currentText === valueText.trim() || valueText.trim().startsWith(currentText));
    if (matches) return;

    console.log(
      `Selection for #mui-component-select-${muiId} (nth=${nth}) didn't stick (shows "${currentText}", expected "${valueText}") — retrying...`
    );
    await page.waitForTimeout(300);
  }
  throw new Error(
    `Could not get #mui-component-select-${muiId} (nth=${nth}) to show "${valueText}" after retries.`
  );
}

/** Click "Get Quote" and wait for navigation to the results page, retrying
 * the click a couple of times in case the first click doesn't register
 * (e.g. button not yet interactive, or a transient overlay). */
async function submitGetQuote(page) {
  const button = page.getByRole("button", { name: "Get Quote" });
  for (let attempt = 0; attempt < 3; attempt++) {
    await button.scrollIntoViewIfNeeded();
    await button.click({ force: true });
    try {
      await page.waitForURL("**/product-recommendations/**", { timeout: 15000 });
      return;
    } catch (err) {
      if (attempt < 2) {
        console.log("Get Quote click didn't navigate yet — retrying...");
        await page.waitForTimeout(500);
        continue;
      }
      // Final attempt failed — capture diagnostics before giving up so we
      // can see what actually blocked submission instead of just a timeout.
      try {
        const shotPath = `submit-failure-${Date.now()}.png`;
        await page.screenshot({ path: shotPath, fullPage: true });
        const bodyText = await page.evaluate(() => document.body.innerText);
        const errorLines = bodyText
          .split("\n")
          .filter((l) => /required|error|invalid|please|must/i.test(l))
          .slice(0, 10);
        console.error(`\nSubmission didn't navigate after 3 attempts.`);
        console.error(`Screenshot saved to: ${shotPath}`);
        console.error(`Current URL: ${page.url()}`);
        if (errorLines.length) {
          console.error(`Possible validation messages on page:\n  ${errorLines.join("\n  ")}`);
        } else {
          console.error(`No obvious validation text found on the page.`);
        }
      } catch (diagErr) {
        console.error("(Could not capture diagnostics:", diagErr.message, ")");
      }
      throw err;
    }
  }
}

async function promptChoice(message, choices, initial = 0) {
  if (!choices || choices.length === 0) {
    throw new Error(`No options available for "${message}" — cannot prompt with an empty list.`);
  }
  const { value } = await prompts(
    {
      type: "select",
      name: "value",
      message,
      choices: choices.map((c) => ({ title: c, value: c })),
      initial,
    },
    {
      onCancel: () => {
        console.log("\nCancelled (Ctrl+C/Esc pressed) — exiting.");
        process.exit(1);
      },
    }
  );
  return value;
}

async function scrapeResultsPage(page) {
  return page.evaluate(() => {
    const results = [];
    const priceNodes = Array.from(document.querySelectorAll("*")).filter(
      (el) => el.children.length === 0 && /^₹[\d,]+$/.test(el.textContent.trim())
    );
    const badges = new Set(["Newly Launched", "Most Bought"]);
    for (const priceEl of priceNodes) {
      let card = priceEl;
      for (let i = 0; i < 8 && card; i++) {
        if (card.innerText && card.innerText.includes("Sum Insured")) break;
        card = card.parentElement;
      }
      if (!card) continue;
      const price = priceEl.textContent.trim();
      const lines = card.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
      const priceIdx = lines.indexOf(price);
      const nameLines = lines
        .slice(0, priceIdx === -1 ? lines.length : priceIdx)
        .filter((l) => !badges.has(l));
      const sumInsuredIdx = lines.findIndex((l) => l === "Sum Insured");
      const sumInsured = sumInsuredIdx !== -1 ? lines[sumInsuredIdx + 1] : "";
      const policyPeriodIdx = lines.findIndex((l) => l === "Policy Period");
      const policyPeriod = policyPeriodIdx !== -1 ? lines[policyPeriodIdx + 1] : "";
      results.push({ name: nameLines.join(" "), price, sumInsured, policyPeriod });
    }
    return results;
  });
}

function dedupePlans(plans) {
  const seen = new Set();
  return plans.filter((p) => {
    const key = p.name + p.price;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function printSummary(input, uniquePlans) {
  console.log("\n=== Your Input ===");
  console.log(`Pincode: ${input.pincode}`);
  console.log(`Category: ${input.category} | Plan: ${input.policyPlan} | Type: ${input.policyType}`);
  console.log(`Product: ${input.product}`);
  console.log(`Sum Insured: ${input.sumInsuredLabel} | Policy Period: ${input.policyPeriod}`);
  console.log(`Members: ${input.members.map((m) => `${m.type} ${m.index} (${m.age})`).join(", ")}`);
  console.log(`PED: ${input.ped}`);

  console.log("\n=== Quote Results ===");
  if (uniquePlans.length === 0) {
    console.log("No plans were parsed. Check the open Chrome tab to inspect the page.");
  } else {
    uniquePlans.forEach((p, i) => {
      console.log(
        `${i + 1}. ${p.name}  —  ${p.price}  (Sum Insured: ${p.sumInsured}, Policy Period: ${p.policyPeriod})`
      );
    });
  }
}

/**
 * Interactive CLI entry point: walks the real form step by step, scraping
 * each dropdown's live option list at the moment it's needed and prompting
 * the user to choose from exactly those options.
 */
export async function runInteractive() {
  const { browser, page } = await connect();
  console.log("Opening AtomPro...\n");

  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    const getQuoteLink = page.getByText("Get Quote", { exact: true });
    await getQuoteLink.waitFor({ state: "visible", timeout: 60000 });
    await getQuoteLink.click();

    // "Choose Your Policy" modal
    await page.getByText("Customer Pincode").first().waitFor();
    const { pincode } = await prompts(
      {
        type: "text",
        name: "pincode",
        message: "Customer pincode",
        validate: (v) => /^\d{6}$/.test(v) || "Enter a valid 6-digit pincode",
      },
      {
      onCancel: () => {
        console.log("\nCancelled (Ctrl+C/Esc pressed) — exiting.");
        process.exit(1);
      },
    }
    );
    const pincodeInput = page.locator('input[type="number"], input[type="text"]').first();
    await pincodeInput.click();
    await pincodeInput.fill(pincode);
    await page.waitForTimeout(800); // let pincode -> city/state resolve
    await page.getByRole("button", { name: "Continue" }).click();

    // Quick quote form
    await page.getByText("Product Category").waitFor();

    // Same reused-profile leftover-state issue as runQuote() below — reset
    // the form before reading live options off it.
    try {
      const clearButton = page.getByRole("button", { name: "Clear" });
      if (await clearButton.count() > 0) {
        await clearButton.click();
        await page.waitForTimeout(300);
      }
    } catch (_) {}

    const category = await promptChoice("Product category", ["Health", "Speciality"]);
    if (category !== "Health") {
      await page.getByText(category, { exact: true }).click();
    }

    console.log("Reading live product list from the site...");
    const productOptions = await scrapeSelectOptions(page, "product");
    const product = await promptChoice("Product", productOptions);
    if (product !== productOptions[0]) {
      await applySelectOption(page, "product", product);
    }

    const policyPlan = await promptChoice("Policy plan", ["Fresh", "Portability"]);
    if (policyPlan !== "Fresh") {
      await page.getByText("Portability", { exact: true }).click();
    }

    const policyType = await promptChoice("Policy type", ["Floater", "Individual"]);
    if (policyType !== "Floater") {
      await page.getByText("Individual", { exact: true }).click();
    }

    console.log("Reading live member-count options from the site...");
    let numParents = "0";
    if (await fieldExists(page, "parents")) {
      const parentCounts = await scrapeSelectOptions(page, "parents");
      numParents = await promptChoice("Number of parents (18-75 yrs)", parentCounts);
      if (numParents !== parentCounts[0]) await applySelectOption(page, "parents", numParents);
    } else {
      console.log("(This product doesn't offer parent coverage — skipping.)");
    }

    const adultCounts = await scrapeSelectOptions(page, "adults");
    const numAdults = await promptChoice("Number of adults (18-100 yrs)", adultCounts, 1);
    if (numAdults !== adultCounts[0]) await applySelectOption(page, "adults", numAdults);

    const childCounts = await scrapeSelectOptions(page, "child");
    const numChildren = await promptChoice("Number of children (16 days - 25 yrs)", childCounts);
    if (numChildren !== childCounts[0]) await applySelectOption(page, "child", numChildren);

    const members = [];
    for (let i = 1; i <= Number(numParents); i++) members.push({ type: "Parent", index: i });
    for (let i = 1; i <= Number(numAdults); i++) members.push({ type: "Adult", index: i });
    for (let i = 1; i <= Number(numChildren); i++) members.push({ type: "Child", index: i });

    if (members.length === 0) {
      console.error("At least one member (parent/adult/child) is required.");
      process.exit(1);
    }

    const memberFieldPrefix = { Parent: "parent", Adult: "adult", Child: "child" };
    for (const m of members) {
      const fieldName = `${memberFieldPrefix[m.type]}${m.index}.age`;
      const ageOptions = await scrapeSelectOptions(page, fieldName);
      const age = await promptChoice(`${m.type} ${m.index} age`, ageOptions);
      await applySelectOption(page, fieldName, age);
      m.age = age;
    }

    const ped = await promptChoice(
      "Do you or anyone in your family have any Pre-Existing Disease (PED)?",
      ["No", "Yes"]
    );
    await page.getByText(ped, { exact: true }).last().click();

    await submitGetQuote(page);
    await page.waitForTimeout(1500);

    console.log("Reading live Sum Insured / Policy Period options from the results page...");
    const sumInsuredOptions = await scrapeSelectOptions(page, "sumInsured", 0);
    const sumInsured = await promptChoice(
      "Sum Insured (applied to every plan)",
      sumInsuredOptions,
      Math.max(sumInsuredOptions.findIndex((o) => /recommended/i.test(o)), 0)
    );
    const policyPeriodOptions = await scrapeSelectOptions(page, "policyPeriod", 0);
    const policyPeriod = await promptChoice(
      "Policy Period (applied to every plan)",
      policyPeriodOptions
    );

    const skippedSumInsured = [];
    const skippedPolicyPeriod = [];
    const cardCount = await page.locator('[id="mui-component-select-sumInsured"]').count();

    for (let i = 0; i < cardCount; i++) {
      const available = await scrapeSelectOptions(page, "sumInsured", i);
      if (available.includes(sumInsured)) {
        await applySelectOption(page, "sumInsured", sumInsured, i);
      } else {
        skippedSumInsured.push(i);
      }
      await page.waitForTimeout(200);
    }
    for (let i = 0; i < cardCount; i++) {
      const available = await scrapeSelectOptions(page, "policyPeriod", i);
      if (available.includes(policyPeriod)) {
        await applySelectOption(page, "policyPeriod", policyPeriod, i);
      } else {
        skippedPolicyPeriod.push(i);
      }
      await page.waitForTimeout(200);
    }
    if (skippedSumInsured.length) {
      console.log(
        `Note: ${skippedSumInsured.length} plan(s) don't offer Sum Insured "${sumInsured}" — left at their default.`
      );
    }
    if (skippedPolicyPeriod.length) {
      console.log(
        `Note: ${skippedPolicyPeriod.length} plan(s) don't offer Policy Period "${policyPeriod}" — left at their default.`
      );
    }
    await page.waitForTimeout(800);

    const plans = await scrapeResultsPage(page);
    const uniquePlans = dedupePlans(plans);

    printSummary(
      {
        pincode,
        category,
        product,
        policyPlan,
        policyType,
        sumInsuredLabel: sumInsured.replace(/Recommended$/i, "").trim(),
        policyPeriod,
        members,
        ped,
      },
      uniquePlans
    );

    return uniquePlans;
  } finally {
    await page.close();
    await browser.close(); // closes the CDP connection only, not your Chrome window
  }
}

/**
 * Programmatic entry point (e.g. for a CRM backend): pass exact values
 * instead of being prompted. Values must match the site's live option text
 * exactly (case-sensitive) — use runInteractive() once to see the current
 * live catalog if you're not sure what's currently offered.
 */
export async function runQuote(input, endpoint = CDP_ENDPOINT) {
  const { browser, page } = await connect(endpoint);
  console.log("Submitting your details to AtomPro...\n");

  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    const getQuoteLink = page.getByText("Get Quote", { exact: true });
    await getQuoteLink.waitFor({ state: "visible", timeout: 60000 });
    await getQuoteLink.click();

    await page.getByText("Customer Pincode").first().waitFor();
    const pincodeInput = page.locator('input[type="number"], input[type="text"]').first();
    await pincodeInput.click();
    await pincodeInput.fill(input.pincode);
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByText("Product Category").waitFor();

    // The Chrome profile behind this connection is reused across every
    // request (that's what lets it pass Akamai's bot check), so AtomPro's
    // form silently carries over field values from whichever request last
    // used it — e.g. "Number of Children" defaulting to a previous
    // caller's count instead of 0, leaving a now-required, unset age field
    // and failing submission. Clicking "Clear" resets the form before we
    // fill anything, so each quote starts from the site's true blank state.
    try {
      const clearButton = page.getByRole("button", { name: "Clear" });
      if (await clearButton.count() > 0) {
        await clearButton.click();
        await page.waitForTimeout(300);
      }
    } catch (_) {
      // Best-effort — if Clear isn't present/clickable, proceed with
      // whatever state the form is in rather than fail the whole quote.
    }

    if (input.category !== "Health") {
      await page.getByText("Speciality", { exact: true }).click();
    }
    if (input.policyPlan !== "Fresh") {
      await page.getByText("Portability", { exact: true }).click();
    }
    if (input.policyType !== "Floater") {
      await page.getByText("Individual", { exact: true }).click();
    }
    if (input.product && input.product !== "Recommend Me") {
      await applySelectOption(page, "product", input.product);
    }

    // "Clear" (above) doesn't reliably zero out these counts on its own —
    // the reused Chrome profile can still carry over a previous caller's
    // count. Force each dropdown to the requested value (including "0")
    // rather than only setting it when > 0, so a stale non-zero count from
    // an earlier request can't silently survive into this one.
    // Returns the count actually left selected afterwards — either the
    // wanted value (if the site offered it) or whatever the site's own
    // default/minimum already was (e.g. "adults" has no "0" option; a
    // proposer is mandatory on this product regardless of what's asked
    // for). Callers use this to catch a count/member mismatch up front
    // instead of discovering it only after a failed submit.
    async function forceCount(muiId, wanted, label) {
      if (!(await fieldExists(page, muiId))) {
        if (Number(wanted) > 0) console.log(`Note: this product doesn't offer ${label} coverage — ignored.`);
        return "0";
      }
      const options = await scrapeSelectOptions(page, muiId);
      if (options.includes(wanted)) {
        await applySelectOption(page, muiId, wanted);
        await page.waitForTimeout(300);
        return wanted;
      }
      const current = (await page.locator(`[id="mui-component-select-${muiId}"]`).textContent()).trim();
      if (Number(wanted) > 0) {
        console.log(`Note: "${wanted}" ${label} not offered (options: ${options.join(", ")}) — leaving as ${current}.`);
      }
      await page.waitForTimeout(300);
      return current;
    }

    const actualParents = await forceCount("parents", String(Number(input.numParents) || 0), "parents");
    const actualAdults = await forceCount("adults", String(Number(input.numAdults) || 0), "adults");
    const actualChildren = await forceCount("child", String(Number(input.numChildren) || 0), "children");

    const memberFieldPrefix = { Parent: "parent", Adult: "adult", Child: "child" };
    const providedCounts = {
      Parent: input.members.filter((m) => m.type === "Parent").length,
      Adult: input.members.filter((m) => m.type === "Adult").length,
      Child: input.members.filter((m) => m.type === "Child").length,
    };
    const actualCounts = { Parent: Number(actualParents), Adult: Number(actualAdults), Child: Number(actualChildren) };
    const shortfalls = Object.entries(actualCounts)
      .filter(([type, count]) => count > providedCounts[type])
      .map(([type, count]) => `${count - providedCounts[type]} more ${type.toLowerCase()}(s) (this product requires ${count} total, only ${providedCounts[type]} age(s) given)`);
    if (shortfalls.length > 0) {
      throw new Error(`Missing member age(s) before this product can be quoted: ${shortfalls.join(", ")}.`);
    }

    for (const m of input.members) {
      const fieldName = `${memberFieldPrefix[m.type]}${m.index}.age`;
      await applySelectOption(page, fieldName, m.age);
      await page.waitForTimeout(300);
    }

    await page.getByText(input.ped, { exact: true }).last().click();

    await submitGetQuote(page);
    await page.waitForTimeout(1500);

    const skippedSumInsured = [];
    const skippedPolicyPeriod = [];
    const cardCount = await page.locator('[id="mui-component-select-sumInsured"]').count();

    if (input.sumInsured && !/^10 Lakh/.test(input.sumInsured)) {
      for (let i = 0; i < cardCount; i++) {
        const available = await scrapeSelectOptions(page, "sumInsured", i);
        if (available.includes(input.sumInsured)) {
          await applySelectOption(page, "sumInsured", input.sumInsured, i);
        } else {
          skippedSumInsured.push(i);
        }
        await page.waitForTimeout(200);
      }
    }
    if (input.policyPeriod && input.policyPeriod !== "1 Year") {
      for (let i = 0; i < cardCount; i++) {
        const available = await scrapeSelectOptions(page, "policyPeriod", i);
        if (available.includes(input.policyPeriod)) {
          await applySelectOption(page, "policyPeriod", input.policyPeriod, i);
        } else {
          skippedPolicyPeriod.push(i);
        }
        await page.waitForTimeout(200);
      }
    }
    if (skippedSumInsured.length) {
      console.log(
        `Note: ${skippedSumInsured.length} plan(s) don't offer Sum Insured "${input.sumInsured}" — left at their default.`
      );
    }
    if (skippedPolicyPeriod.length) {
      console.log(
        `Note: ${skippedPolicyPeriod.length} plan(s) don't offer Policy Period "${input.policyPeriod}" — left at their default.`
      );
    }
    await page.waitForTimeout(800);

    const plans = await scrapeResultsPage(page);
    const uniquePlans = dedupePlans(plans);

    printSummary(
      {
        ...input,
        sumInsuredLabel: (input.sumInsured || "10 Lakh").replace(/Recommended$/i, "").trim(),
      },
      uniquePlans
    );

    return uniquePlans;
  } finally {
    await page.close();
    await browser.close();
  }
}

if (process.argv[1] && process.argv[1].endsWith("index.js")) {
  runInteractive().catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  });
}
