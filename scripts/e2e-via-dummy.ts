/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * End-to-end test driver that exercises the dashboard against the dummy
 * auto_gui2 server over real HTTP.
 *
 * Intent coverage suite — one assertion per sheet-backed scenario key. The
 * driver seeds an SO at the right deriveStage(), sends a crafted reply, and
 * asserts the LLM picked the expected scenarioKey (or an accepted equivalent).
 *
 * Shared infrastructure (Gmail stub, fetch interceptor, dummy lifecycle, DB
 * seeding, waitFor) lives in [scripts/e2e-shared.ts](scripts/e2e-shared.ts).
 * Importing it has side effects (installs the require hook + fetch interceptor)
 * so it MUST be imported before any engine module is loaded.
 *
 * Environment:
 *   DATABASE_URL   defaults to file:./test-e2e.db (separate from dev.db)
 *   DASHBOARD_URL  defaults to http://localhost:3001 (driver-internal port)
 *   DUMMY_URL      defaults to http://localhost:8001
 */

import * as fs from 'node:fs';
import {
  HTTP_LOG,
  PLENTY_STOCK,
  STOCKED_MATERIALS,
  TEST_MATERIALS,
  loadEngine,
  seedInventory,
  seedSO,
  startBridge,
  startDummy,
  stopBridge,
  stopDummy,
  wipeAll,
} from './e2e-shared';
import type { Env } from './e2e-shared';

// -----------------------------------------------------------------------------
// Test result recorder
// -----------------------------------------------------------------------------

interface TestResult {
  id: string;
  pass: boolean;
  details: string;
}

const RESULTS: TestResult[] = [];

function record(id: string, pass: boolean, details: string) {
  RESULTS.push({ id, pass, details });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`[${id} ${tag}] ${details}`);
}

// -----------------------------------------------------------------------------
// Intent-coverage tests — one per sheet-backed scenario key
// -----------------------------------------------------------------------------
//
// Each spec seeds an SO at the stage that deriveStage() would compute as the
// LLM's `CURRENT STAGE` value, then sends a reply text crafted to nudge the
// classifier to the target intent. The driver asserts:
//   1. The LLM picked the expected scenarioKey (or accepts a documented
//      equivalence — e.g. release_all vs release_part on the same SO when
//      M-C has zero stock).
//   2. The engine's first step fired (we don't drive subsequent segments;
//      this is intent coverage, not full lifecycle).

interface IntentSpec {
  id: string;
  expectedKey: string;
  /** Acceptable alternative scenarioKeys the LLM might pick (semantic overlap). */
  alsoAccept?: string[];
  /**
   * Acceptable alternative legacy *actions* the dispatcher routes through
   * non-scenario handlers (e.g. `2nd_release_decision`, `dispatch_confirmation_decision`,
   * `vehicle_details_extraction`). When present, the test passes if the
   * classifier picked any of these actions, even if no ScenarioProgress row
   * was created.
   */
  alsoAcceptAction?: string[];
  stage: 'before_ls' | 'after_ls_before_invoice' | 'after_vehicle_placement' | 'after_email_to_plant' | 'after_plant_invoice';
  triggerEmailType: string;
  triggerEmailRecipient?: 'branch' | 'plant';
  replyText: string;
  /** Override default 3-material fixture (e.g. all materials in stock). */
  materials?: typeof TEST_MATERIALS;
  /** Optional: seed inventory_snapshot rows before the run. */
  inventory?: Array<{ material: string; freeStock: number }>;
  /** Optional: SO number to use (defaults to auto). */
  soNumber?: string;
  /**
   * Override the per-test settle delay before checking DB state. Tests that
   * trigger supervisor escalation or other async side-effects sometimes need
   * a longer wait. Default: 200 ms.
   */
  settleMs?: number;
}

let soCounter = 3270000;
const nextSO = () => String(++soCounter);

const INTENT_SPECS: IntentSpec[] = [
  // ───────────────────── BEFORE LS — Product Clarification ─────────────────────
  {
    id: 'release_all',
    expectedKey: 'branch|before_ls|release_all|-',
    stage: 'before_ls',
    triggerEmailType: 'ls_dispatch',
    replyText: 'Please release everything as available. All quantities approved, go ahead and dispatch.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'release_part',
    expectedKey: 'branch|before_ls|release_part|-',
    stage: 'before_ls',
    triggerEmailType: 'ls_dispatch',
    replyText: 'Release the materials you have available, skip the ones with zero stock.',
    // Default TEST_MATERIALS has one M-C at 0 stock — perfect for release_part.
  },
  {
    id: 'wait',
    expectedKey: 'branch|before_ls|wait|-',
    stage: 'before_ls',
    triggerEmailType: 'ls_dispatch',
    replyText: 'Please hold this order. Wait for material to arrive before proceeding.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },

  // ───────────────────── BEFORE LS — Modifications ─────────────────────────────
  {
    id: 'before_ls_modify_increase',
    expectedKey: 'branch|before_ls|modify|increase',
    stage: 'before_ls',
    triggerEmailType: 'ls_dispatch',
    replyText: 'Please increase material YE1EDWO00001APJP from 50 to 80 units.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'before_ls_modify_inc_dec',
    expectedKey: 'branch|before_ls|modify|inc_dec',
    stage: 'before_ls',
    triggerEmailType: 'ls_dispatch',
    replyText: 'Increase YE1EDWO00001APJP to 80 and decrease YV6FRYENE0000PJP to 50.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'before_ls_modify_inc_del',
    expectedKey: 'branch|before_ls|modify|inc_del',
    stage: 'before_ls',
    triggerEmailType: 'ls_dispatch',
    replyText: 'Increase YE1EDWO00001APJP to 80 and remove YA4COWOCR000043P entirely from the order.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'before_ls_modify_delete',
    expectedKey: 'branch|before_ls|modify|delete',
    stage: 'before_ls',
    triggerEmailType: 'ls_dispatch',
    replyText: 'Please delete YA4COWOCR000043P from the order. No quantity changes elsewhere.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'before_ls_modify_decrease',
    expectedKey: 'branch|before_ls|modify|decrease',
    stage: 'before_ls',
    triggerEmailType: 'ls_dispatch',
    replyText: 'Reduce YE1EDWO00001APJP from 50 to 30 units. No deletions, no increases.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'before_ls_modify_dec_del',
    expectedKey: 'branch|before_ls|modify|dec_del',
    stage: 'before_ls',
    triggerEmailType: 'ls_dispatch',
    replyText: 'Reduce YE1EDWO00001APJP to 30 and remove YA4COWOCR000043P from the order.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },

  // ───────────────────── BEFORE LS — Special intents ───────────────────────────
  {
    id: 'before_ls_new_so',
    expectedKey: 'branch|before_ls|new_so|-',
    stage: 'before_ls',
    triggerEmailType: 'ls_dispatch',
    replyText: 'NEW ORDER — please process the attached sales order.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    // The LLM routinely routes "yes, the revised plan is acceptable" through
    // the legacy 2nd_release_decision action (handleSecondReleaseReply) rather
    // than creating a fresh scenario row. Both are valid handlers of the
    // sheet's "Second Release confirmation" intent.
    id: 'before_ls_2nd_release',
    expectedKey: 'branch|before_ls|2nd_release|-',
    alsoAcceptAction: ['2nd_release_decision'],
    stage: 'before_ls',
    triggerEmailType: '2nd_release',
    replyText: 'Yes, the revised release plan is acceptable. Please proceed with the updated quantities.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'before_ls_discount_confirm',
    expectedKey: 'branch|before_ls|discount_confirm|-',
    stage: 'before_ls',
    triggerEmailType: 'ls_dispatch',
    replyText: 'Confirmed — please apply the agreed discount code DISC25 and proceed with the order.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'before_ls_clarify_weight',
    expectedKey: 'branch|before_ls|clarify_weight|-',
    stage: 'before_ls',
    triggerEmailType: 'ls_dispatch',
    replyText: 'Quick question on vehicle weight — our truck capacity is 25T, can we accommodate the planned loading?',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },

  // ───────────────────── AFTER LS, before vehicle ──────────────────────────────
  {
    id: 'after_ls_modify_increase',
    expectedKey: 'branch|after_ls_before_invoice|modify|increase',
    stage: 'after_ls_before_invoice',
    triggerEmailType: 'vehicle_details',
    replyText: 'Please increase YE1EDWO00001APJP to 80 units on the loading slip.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'after_ls_modify_inc_dec',
    expectedKey: 'branch|after_ls_before_invoice|modify|inc_dec',
    stage: 'after_ls_before_invoice',
    triggerEmailType: 'vehicle_details',
    replyText: 'Increase YE1EDWO00001APJP to 80 and reduce YV6FRYENE0000PJP to 50 on the LS.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'after_ls_modify_inc_del',
    expectedKey: 'branch|after_ls_before_invoice|modify|inc_del',
    stage: 'after_ls_before_invoice',
    triggerEmailType: 'vehicle_details',
    replyText: 'Increase YE1EDWO00001APJP to 80 and remove YA4COWOCR000043P from the LS.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'after_ls_modify_decrease',
    expectedKey: 'branch|after_ls_before_invoice|modify|decrease',
    stage: 'after_ls_before_invoice',
    triggerEmailType: 'vehicle_details',
    replyText: 'Please reduce YE1EDWO00001APJP from 50 to 30 on the LS.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'after_ls_modify_delete',
    expectedKey: 'branch|after_ls_before_invoice|modify|delete',
    stage: 'after_ls_before_invoice',
    triggerEmailType: 'vehicle_details',
    replyText: 'Remove YA4COWOCR000043P from the LS entirely.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'after_ls_modify_dec_del',
    expectedKey: 'branch|after_ls_before_invoice|modify|dec_del',
    stage: 'after_ls_before_invoice',
    triggerEmailType: 'vehicle_details',
    replyText: 'Reduce YE1EDWO00001APJP to 30 and remove YA4COWOCR000043P from the LS.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    // Same as before_ls_2nd_release — legacy action path is acceptable.
    id: 'after_ls_2nd_release',
    expectedKey: 'branch|after_ls_before_invoice|2nd_release|-',
    alsoAcceptAction: ['2nd_release_decision'],
    stage: 'after_ls_before_invoice',
    triggerEmailType: '2nd_release',
    replyText: 'Yes — the revised quantities on the LS are correct, please proceed.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    // LLM may route vehicle-info replies through the legacy
    // vehicle_details_extraction action (handleVehicleDetailsReply) rather
    // than create a fresh scenario. Both handle the same sheet intent.
    id: 'after_ls_vehicle_details',
    expectedKey: 'branch|after_ls_before_invoice|vehicle_details|-',
    alsoAcceptAction: ['vehicle_details_extraction'],
    stage: 'after_ls_before_invoice',
    triggerEmailType: 'vehicle_details',
    replyText: 'Vehicle number GJ12-XY1234, driver Ramesh, mobile 9876543210. LR number LR-9988, dated 30.05.2026.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },

  // ───────────────────── AFTER VEHICLE PLACEMENT ───────────────────────────────
  {
    id: 'after_vehicle_modify_increase',
    expectedKey: 'branch|after_vehicle_placement|modify|increase',
    stage: 'after_vehicle_placement',
    triggerEmailType: 'vehicle_details',
    replyText: 'After vehicle placement: please increase YE1EDWO00001APJP to 80 units.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'after_vehicle_modify_inc_dec',
    expectedKey: 'branch|after_vehicle_placement|modify|inc_dec',
    stage: 'after_vehicle_placement',
    triggerEmailType: 'vehicle_details',
    replyText: 'Vehicle is placed — increase YE1EDWO00001APJP to 80 and decrease YV6FRYENE0000PJP to 50.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'after_vehicle_modify_inc_del',
    expectedKey: 'branch|after_vehicle_placement|modify|inc_del',
    stage: 'after_vehicle_placement',
    triggerEmailType: 'vehicle_details',
    replyText: 'Vehicle here — increase YE1EDWO00001APJP to 80 and remove YA4COWOCR000043P.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'after_vehicle_modify_decrease',
    expectedKey: 'branch|after_vehicle_placement|modify|decrease',
    stage: 'after_vehicle_placement',
    triggerEmailType: 'vehicle_details',
    replyText: 'Vehicle has arrived — reduce YE1EDWO00001APJP to 30 units, no deletions.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'after_vehicle_modify_delete',
    expectedKey: 'branch|after_vehicle_placement|modify|delete',
    stage: 'after_vehicle_placement',
    triggerEmailType: 'vehicle_details',
    replyText: 'Vehicle placed — please remove YA4COWOCR000043P from the dispatch.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'after_vehicle_modify_dec_del',
    expectedKey: 'branch|after_vehicle_placement|modify|dec_del',
    stage: 'after_vehicle_placement',
    triggerEmailType: 'vehicle_details',
    replyText: 'Vehicle is here — reduce YE1EDWO00001APJP to 30 and remove YA4COWOCR000043P.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },

  // ───────────────────── AFTER EMAIL TO PLANT — branch modifications ───────────
  {
    id: 'after_eml_plant_modify_increase',
    expectedKey: 'branch|after_email_to_plant|modify|increase',
    stage: 'after_email_to_plant',
    triggerEmailType: 'vehicle_details',
    replyText: 'Plant already has the LS — please still increase YE1EDWO00001APJP to 80 units.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'after_eml_plant_modify_inc_dec',
    expectedKey: 'branch|after_email_to_plant|modify|inc_dec',
    stage: 'after_email_to_plant',
    triggerEmailType: 'vehicle_details',
    replyText: 'Plant has the LS — increase YE1EDWO00001APJP to 80 and decrease YV6FRYENE0000PJP to 50.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'after_eml_plant_modify_inc_del',
    expectedKey: 'branch|after_email_to_plant|modify|inc_del',
    stage: 'after_email_to_plant',
    triggerEmailType: 'vehicle_details',
    replyText: 'Plant has the LS — increase YE1EDWO00001APJP to 80 and remove YA4COWOCR000043P.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'after_eml_plant_modify_decrease',
    expectedKey: 'branch|after_email_to_plant|modify|decrease',
    stage: 'after_email_to_plant',
    triggerEmailType: 'vehicle_details',
    replyText: 'Plant has the LS — please reduce YE1EDWO00001APJP to 30 units.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'after_eml_plant_modify_delete',
    expectedKey: 'branch|after_email_to_plant|modify|delete',
    stage: 'after_email_to_plant',
    triggerEmailType: 'vehicle_details',
    replyText: 'Plant has the LS — please remove YA4COWOCR000043P from the order.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'after_eml_plant_modify_dec_del',
    expectedKey: 'branch|after_email_to_plant|modify|dec_del',
    stage: 'after_email_to_plant',
    triggerEmailType: 'vehicle_details',
    replyText: 'Plant has the LS — reduce YE1EDWO00001APJP to 30 and remove YA4COWOCR000043P.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },

  // ───────────────────── AFTER PLANT INVOICE — branch modifications ────────────
  {
    id: 'after_inv_modify_increase',
    expectedKey: 'branch|after_plant_invoice|modify|increase',
    stage: 'after_plant_invoice',
    triggerEmailType: 'vehicle_details',
    replyText: 'Invoice already received — please still increase YE1EDWO00001APJP to 80 units.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'after_inv_modify_inc_dec',
    expectedKey: 'branch|after_plant_invoice|modify|inc_dec',
    stage: 'after_plant_invoice',
    triggerEmailType: 'vehicle_details',
    replyText: 'Invoice in hand — increase YE1EDWO00001APJP to 80 and decrease YV6FRYENE0000PJP to 50.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'after_inv_modify_inc_del',
    expectedKey: 'branch|after_plant_invoice|modify|inc_del',
    stage: 'after_plant_invoice',
    triggerEmailType: 'vehicle_details',
    replyText: 'Invoice in hand — increase YE1EDWO00001APJP to 80 and remove YA4COWOCR000043P.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'after_inv_modify_decrease',
    expectedKey: 'branch|after_plant_invoice|modify|decrease',
    stage: 'after_plant_invoice',
    triggerEmailType: 'vehicle_details',
    replyText: 'Invoice received — please reduce YE1EDWO00001APJP to 30 units.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'after_inv_modify_delete',
    expectedKey: 'branch|after_plant_invoice|modify|delete',
    stage: 'after_plant_invoice',
    triggerEmailType: 'vehicle_details',
    replyText: 'Invoice received — please remove YA4COWOCR000043P from the order.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'after_inv_modify_dec_del',
    expectedKey: 'branch|after_plant_invoice|modify|dec_del',
    stage: 'after_plant_invoice',
    triggerEmailType: 'vehicle_details',
    replyText: 'Invoice received — reduce YE1EDWO00001APJP to 30 and remove YA4COWOCR000043P.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },

  // ───────────────────── ANYTIME intents (branch) ──────────────────────────────
  {
    id: 'anytime_status_update',
    expectedKey: 'branch|anytime|status_update|-',
    stage: 'before_ls',
    triggerEmailType: 'ls_dispatch',
    replyText: 'Can you tell me the current status of this SO? Has the LS been created yet? Where is the order in the pipeline?',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'anytime_other',
    expectedKey: 'branch|anytime|other|-',
    alsoAccept: ['__action_other__'], // legacy unknown-intent path is also fine
    stage: 'before_ls',
    triggerEmailType: 'ls_dispatch',
    replyText: 'foo bar baz, lorem ipsum, totally unrelated filler text with no actionable intent at all',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },

  // ───────────────────── PLANT modifications (Before Plant Invoice) ───────────
  {
    id: 'plant_modify_increase',
    expectedKey: 'plant|after_email_to_plant|modify|increase',
    stage: 'after_email_to_plant',
    triggerEmailType: 'plant_ls',
    triggerEmailRecipient: 'plant',
    replyText: 'Plant update: we can ship 80 units of YE1EDWO00001APJP (higher than ordered 50).',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    // Explicit from→to numbers so the LLM doesn't second-guess whether 50
    // is a decrease from the ordered 100 (it ALWAYS is in this fixture).
    id: 'plant_modify_inc_dec',
    expectedKey: 'plant|after_email_to_plant|modify|inc_dec',
    stage: 'after_email_to_plant',
    triggerEmailType: 'plant_ls',
    triggerEmailRecipient: 'plant',
    replyText: 'Plant: please increase YE1EDWO00001APJP from 50 to 80 units, and decrease YV6FRYENE0000PJP from 100 to 50 units.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    // Sharpen wording: "delete" is unambiguous where "unavailable" had been
    // interpreted as a decrease-to-zero. Also give async escalation a longer
    // settle window if the classifier hedges into unknown+escalate.
    id: 'plant_modify_inc_del',
    expectedKey: 'plant|after_email_to_plant|modify|inc_del',
    stage: 'after_email_to_plant',
    triggerEmailType: 'plant_ls',
    triggerEmailRecipient: 'plant',
    replyText: 'Plant: please increase YE1EDWO00001APJP to 80 units, and delete material YA4COWOCR000043P from the LS entirely (do not dispatch this material at all).',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
    settleMs: 1500,
  },
  {
    id: 'plant_modify_decrease',
    expectedKey: 'plant|after_email_to_plant|modify|decrease',
    stage: 'after_email_to_plant',
    triggerEmailType: 'plant_ls',
    triggerEmailRecipient: 'plant',
    replyText: 'Plant: only 30 units of YE1EDWO00001APJP available — short of ordered.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    // Sharpened wording: explicit "delete" beats "unavailable" which the
    // LLM occasionally read as "hold/wait" or "decrease to 0 / clarify".
    id: 'plant_modify_delete',
    expectedKey: 'plant|after_email_to_plant|modify|delete',
    stage: 'after_email_to_plant',
    triggerEmailType: 'plant_ls',
    triggerEmailRecipient: 'plant',
    replyText: 'Plant: please delete material YA4COWOCR000043P from the LS entirely (do not dispatch this material at all). All other materials remain unchanged.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    // Sharpen wording: explicit "decrease ... to 30" + "delete" so the LLM
    // doesn't conflate "unavailable" with decrease-to-zero. Documented drift
    // across earlier sessions; fixture clarity is the right fix here.
    id: 'plant_modify_dec_del',
    expectedKey: 'plant|after_email_to_plant|modify|dec_del',
    stage: 'after_email_to_plant',
    triggerEmailType: 'plant_ls',
    triggerEmailRecipient: 'plant',
    replyText: 'Plant: please decrease YE1EDWO00001APJP from 50 to 30 units, and delete material YA4COWOCR000043P from the LS entirely (do not dispatch this material at all).',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },

  // ───────────────────── PLANT — invoice arrival + anytime ─────────────────────
  {
    id: 'plant_invoice_sent',
    expectedKey: 'plant|after_plant_invoice|invoice_sent|-',
    stage: 'after_email_to_plant',
    triggerEmailType: 'plant_ls',
    triggerEmailRecipient: 'plant',
    replyText: 'Please find the plant invoice attached. Material has been dispatched, invoice number 7682614520 / OBD 85817679.',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
  {
    id: 'plant_anytime_other',
    expectedKey: 'plant|anytime|other|-',
    alsoAccept: ['__action_other__'],
    stage: 'after_email_to_plant',
    triggerEmailType: 'plant_ls',
    triggerEmailRecipient: 'plant',
    replyText: 'Random plant note unrelated to dispatch or invoices, no actionable content',
    materials: STOCKED_MATERIALS,
    inventory: PLENTY_STOCK,
  },
];

// -----------------------------------------------------------------------------
// Generic intent test runner
// -----------------------------------------------------------------------------

async function runIntentTest(env: Env, spec: IntentSpec) {
  const { prisma, handleReplyV2 } = env;
  await wipeAll(prisma);
  const soNumber = spec.soNumber ?? nextSO();
  const { so, trigger } = await seedSO(prisma, {
    soNumber,
    materials: spec.materials ?? TEST_MATERIALS,
    stage: spec.stage,
    triggerEmailType: spec.triggerEmailType,
    triggerEmailRecipient: spec.triggerEmailRecipient,
  });
  await seedInventory(
    prisma,
    process.env.SAP_DEFAULT_PLANT!,
    spec.inventory ?? TEST_MATERIALS.map((m) => ({ material: m.material, freeStock: 300 })),
  );

  let matched = false;
  try {
    const r = await handleReplyV2({
      emailId: trigger.id,
      replyHtml: spec.replyText,
      originalEmailHtml: trigger.sentBody ?? '',
      sourceEmailType: spec.triggerEmailRecipient === 'plant' ? 'plant' : 'branch',
    });
    matched = r.matched;
  } catch (err) {
    record(spec.id, false, `handleReplyV2 threw: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  await new Promise((r) => setTimeout(r, spec.settleMs ?? 200));

  const progress = await prisma.scenarioProgress.findFirst({
    where: { salesOrderId: so.id },
    orderBy: { createdAt: 'desc' },
  });
  const supervisor = await prisma.email.findFirst({
    where: { salesOrderId: so.id, emailType: 'supervisor_inquiry' },
  });
  const lastDecision = await prisma.scenarioEvent.findFirst({
    where: { salesOrderId: so.id, type: 'classifier_decision' },
    orderBy: { createdAt: 'desc' },
  });
  let lastAction: string | null = null;
  if (lastDecision?.payload) {
    try {
      const p = JSON.parse(lastDecision.payload) as { action?: string };
      lastAction = p.action ?? null;
    } catch {}
  }

  const gotKey = progress?.scenarioKey;
  const acceptsKey = [spec.expectedKey, ...(spec.alsoAccept ?? [])];
  const acceptsAction = spec.alsoAcceptAction ?? [];

  let ok = false;
  let actual = `key=${gotKey ?? '(none)'} action=${lastAction ?? '(none)'}`;

  if (gotKey && acceptsKey.includes(gotKey)) {
    ok = true;
  } else if (lastAction && acceptsAction.includes(lastAction)) {
    ok = true;
    actual += ` (accepted legacy action)`;
  } else if (acceptsKey.includes('__action_other__') && supervisor) {
    ok = true;
    actual += ` (legacy action=other path; supervisor_email=true)`;
  }

  if (!ok && !matched && !supervisor && !lastAction) {
    actual += ` matched=false no_supervisor_email`;
  }

  record(spec.id, ok, `expected=${spec.expectedKey} ${actual}`);
}

// -----------------------------------------------------------------------------
// Deep-dive tests (full SAP round-trip + audit-trail content)
// -----------------------------------------------------------------------------

async function DEEP_T11_plantInvoiceArrival(env: Env) {
  const { prisma, enqueueWork, pumpQueue } = env;
  await wipeAll(prisma);
  const soNumber = nextSO();
  const { so } = await seedSO(prisma, {
    soNumber,
    materials: TEST_MATERIALS,
    stage: 'after_ls_before_invoice',
    triggerEmailType: 'plant_ls',
    triggerEmailRecipient: 'plant',
  });
  const poRow = await prisma.salesOrder.findUnique({
    where: { id: so.id },
    select: { purchaseOrderId: true },
  });
  const bundle = await prisma.bundle.findFirst({
    where: { purchaseOrderId: poRow!.purchaseOrderId },
  });
  await enqueueWork({
    salesOrderId: so.id,
    step: 'zload3b1' as any,
    payload: {
      transaction_code: 'ZLOAD3-B1',
      so_number: so.soNumber,
      instruction: `Execute ZLOAD3-B1 for SO ${so.soNumber}`,
      meta: { so_number: so.soNumber, bundle_id: bundle?.id },
      attachments: [
        { filename: 'invoice-1.pdf', content_base64: 'JVBERi0xLjQK' },
        { filename: 'invoice-2.pdf', content_base64: 'JVBERi0xLjQK' },
        { filename: 'invoice-3.pdf', content_base64: 'JVBERi0xLjQK' },
      ],
    } as any,
  });
  await pumpQueue();

  // Poll for invoice creation.
  const start = Date.now();
  let invoice = null;
  while (Date.now() - start < 15000) {
    invoice = await prisma.invoice.findUnique({ where: { salesOrderId: so.id } });
    if (invoice) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const lsisWithMatDoc = await prisma.loadingSlipItem.findMany({
    where: { salesOrderId: so.id, sapMaterialDoc: { not: null } },
    select: { lsNumber: true, sapMaterialDoc: true, sapLoadedQuantity: true },
  });

  if (!invoice) {
    record('DEEP_T11_zload3_roundtrip', false, 'no Invoice row created after ZLOAD3 callback');
    return;
  }
  const okInvoice = !!invoice.invoiceNumber && invoice.invoiceNumber !== 'PENDING';
  const okLsi = lsisWithMatDoc.length === TEST_MATERIALS.length;
  const summary = `invoice=${invoice.invoiceNumber} obd=${invoice.obdNumber} lsi_with_mat_doc=${lsisWithMatDoc.length}/${TEST_MATERIALS.length}`;
  record('DEEP_T11_zload3_roundtrip', okInvoice && okLsi, summary);
}

async function DEEP_T12_orderStatusSenderFired(env: Env) {
  const { prisma, handleReplyV2 } = env;
  await wipeAll(prisma);
  const soNumber = nextSO();
  const { so, trigger } = await seedSO(prisma, {
    soNumber,
    materials: STOCKED_MATERIALS,
    stage: 'before_ls',
    triggerEmailType: 'ls_dispatch',
  });
  await handleReplyV2({
    emailId: trigger.id,
    replyHtml: `Can you tell me the current status of SO ${soNumber}? Has the LS been created yet?`,
    originalEmailHtml: trigger.sentBody ?? '',
    sourceEmailType: 'branch',
  });
  await new Promise((r) => setTimeout(r, 200));
  const orderStatusEmail = await prisma.email.findFirst({
    where: { salesOrderId: so.id, emailType: 'order_status' },
  });
  const ok = !!orderStatusEmail && (orderStatusEmail.sentBody?.length ?? 0) > 50;
  record(
    'DEEP_T12_order_status_sender',
    ok,
    `email_exists=${!!orderStatusEmail} body_len=${orderStatusEmail?.sentBody?.length ?? 0}`,
  );
}

async function DEEP_T15_auditTrailEvents(env: Env) {
  const { prisma, handleReplyV2, renderAuditTrailForSO } = env;
  await wipeAll(prisma);
  const soNumber = nextSO();
  const { so, trigger } = await seedSO(prisma, {
    soNumber,
    materials: STOCKED_MATERIALS,
    stage: 'before_ls',
    triggerEmailType: 'ls_dispatch',
  });
  await seedInventory(prisma, process.env.SAP_DEFAULT_PLANT!, PLENTY_STOCK);
  await handleReplyV2({
    emailId: trigger.id,
    replyHtml: 'Please release everything as available.',
    originalEmailHtml: trigger.sentBody ?? '',
    sourceEmailType: 'branch',
  });
  await new Promise((r) => setTimeout(r, 300));
  const rendered = await renderAuditTrailForSO({ salesOrderId: so.id });
  const hasScenarioEvent = /scenario_started|scenario_completed|classifier_decision/.test(rendered);
  const lines = rendered.split('\n').filter(Boolean).length;
  const ok = rendered.length > 0 && hasScenarioEvent && lines >= 3;
  record(
    'DEEP_T15_audit_trail',
    ok,
    `len=${rendered.length} lines=${lines} hasScenarioEvent=${hasScenarioEvent}`,
  );
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  const filter = (process.env.FILTER ?? '').trim();
  const filterSet = filter ? new Set(filter.split(',').map((s) => s.trim())) : null;

  const specsToRun = filterSet ? INTENT_SPECS.filter((s) => filterSet.has(s.id)) : INTENT_SPECS;
  const runDeep = !filterSet || filterSet.has('deep');

  console.log(`\n============================================================`);
  console.log(`E2E-via-dummy driver — segmented mode`);
  console.log(`DATABASE_URL=${process.env.DATABASE_URL}`);
  console.log(`AUTO_GUI=${process.env.AUTO_GUI_HOST}:${process.env.AUTO_GUI_PORT}`);
  console.log(`Intent specs: ${specsToRun.length}/${INTENT_SPECS.length}`);
  console.log(`Deep-dive tests: ${runDeep ? 'yes' : 'no'}`);
  console.log(`============================================================\n`);

  fs.writeFileSync('/tmp/dummy-e2e.log', '');

  await startBridge();
  await startDummy();
  console.log(`✓ dummy auto_gui2 started\n`);

  const env = await loadEngine();
  console.log(`✓ engine modules loaded\n`);

  try {
    let i = 0;
    for (const spec of specsToRun) {
      i += 1;
      console.log(`\n[${i}/${specsToRun.length}] ${spec.id}  (expects ${spec.expectedKey})`);
      await runIntentTest(env, spec);
    }
    if (runDeep) {
      console.log(`\n--- deep-dive tests ---`);
      await DEEP_T11_plantInvoiceArrival(env);
      await DEEP_T12_orderStatusSenderFired(env);
      await DEEP_T15_auditTrailEvents(env);
    }
  } finally {
    stopDummy();
    stopBridge();
  }

  console.log(`\n============================================================`);
  const passed = RESULTS.filter((r) => r.pass).length;
  const failed = RESULTS.filter((r) => !r.pass).length;
  console.log(`AGGREGATE [segmented]: ${passed} PASS / ${failed} FAIL / ${RESULTS.length} total`);
  console.log(`============================================================`);
  for (const r of RESULTS) {
    console.log(`  ${r.pass ? '✓' : '✗'} ${r.id.padEnd(38)} ${r.details}`);
  }
  console.log(`\nHTTP log (last 40):`);
  for (const h of HTTP_LOG.slice(-40)) {
    console.log(`  ${h.method.padEnd(5)} ${h.url}  → ${h.status ?? '?'}`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  stopDummy();
  process.exit(2);
});
