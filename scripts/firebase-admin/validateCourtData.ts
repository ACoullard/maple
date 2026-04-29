/**
 * Validates that all fields MAPLE's scrapers depend on are present and
 * correctly typed for a given General Court (or a range of courts). Samples
 * bills, members, sessions, committees, and hearings, then writes output files:
 *
 *   scripts/validation-results/court-{n}-{timestamp}.json   ← all detail
 *   scripts/validation-results/court-{n}-{timestamp}.md     ← human summary
 *
 * Range mode additionally writes a cross-court summary:
 *   scripts/validation-results/range-{min}-{max}-{timestamp}.md
 *   scripts/validation-results/range-{min}-{max}-{timestamp}.json
 *
 * Read-only — no Firestore writes.
 *
 * Usage (single court):
 *   npx ts-node --swc -P tsconfig.script.json scripts/firebase-admin \
 *     run-script validateCourtData --env local --court 191 --billSamples 30
 *
 * Usage (range):
 *   npx ts-node --swc -P tsconfig.script.json scripts/firebase-admin \
 *     run-script validateCourtData --env local --minCourt 186 --maxCourt 194 --billSamples 10
 *
 * Single-court options:
 *   --court         General Court number to validate
 *   --billSamples   Bill documents to sample (default: 30)
 *   --memberSamples Member records to sample (default: 30)
 *
 * Range options:
 *   --minCourt      First court in range (inclusive)
 *   --maxCourt      Last court in range (inclusive)
 *   --billSamples   Bill documents to sample per court (default: 10)
 *   --memberSamples Member records to sample per court (default: 10)
 */

import * as fs from "fs"
import * as path from "path"
import { z } from "zod"
import { axios as malegisAxios } from "../../functions/src/malegislature"
import { Script } from "./types"

// ─── arg parsing ─────────────────────────────────────────────────────────────

const SingleArgs = z.object({
  court: z.coerce.number(),
  billSamples: z.coerce.number().default(30),
  memberSamples: z.coerce.number().default(30)
})

const RangeArgs = z.object({
  minCourt: z.coerce.number(),
  maxCourt: z.coerce.number(),
  billSamples: z.coerce.number().default(10),
  memberSamples: z.coerce.number().default(10)
})

// ─── field specs ─────────────────────────────────────────────────────────────
// Each spec describes one field MAPLE's scrapers read.
// `path` uses dot-notation. `nullable` means null is a valid value.
// `optional` means the field itself may be absent. `note` surfaces in the report.

interface FieldSpec {
  path: string
  expectedType: "string" | "number" | "boolean" | "array" | "object"
  nullable?: boolean
  optional?: boolean
  usedBy: string      // which MAPLE type/function reads this
  note?: string
}

const BILL_LISTING_SPECS: FieldSpec[] = [
  { path: "BillNumber",       expectedType: "string",  nullable: true,  usedBy: "listIds() — filtered for non-null" },
  { path: "DocketNumber",     expectedType: "string",  nullable: true, usedBy: "not stored by MAPLE", note: "DocumentListing types this as string (non-null), but nullable here in case the API diverges" },
  { path: "Title",            expectedType: "string",  usedBy: "not stored from listing; from full doc" },
  { path: "PrimarySponsor",   expectedType: "object",  nullable: true,  usedBy: "not stored from listing" },
  { path: "Cosponsors",       expectedType: "array",   usedBy: "not stored from listing" },
  { path: "IsDocketBookOnly", expectedType: "boolean", usedBy: "not stored by MAPLE" }
]

const BILL_DOCUMENT_SPECS: FieldSpec[] = [
  { path: "Title",              expectedType: "string",  usedBy: "BillContent.Title" },
  { path: "Pinslip",            expectedType: "string",  nullable: true,  usedBy: "BillContent.Pinslip" },
  { path: "PrimarySponsor",     expectedType: "object",  nullable: true,  usedBy: "BillContent.PrimarySponsor" },
  { path: "PrimarySponsor.Name",expectedType: "string",  optional: true,  usedBy: "BillContent.PrimarySponsor.Name — only when sponsor non-null" },
  { path: "DocumentText",       expectedType: "string",  nullable: true, optional: true, usedBy: "BillContent.DocumentText — deleted if null" },
  { path: "Cosponsors",         expectedType: "array",   usedBy: "BillContent.Cosponsors" },
  { path: "LegislationTypeName",expectedType: "string",  usedBy: "not in MAPLE type — useful for filtering non-bills" },
  { path: "CommitteeRecommendations", expectedType: "array", usedBy: "not stored by MAPLE" },
  { path: "Amendments",         expectedType: "array",   usedBy: "not stored by MAPLE" }
]

const BILL_HISTORY_SPECS: FieldSpec[] = [
  { path: "Date",       expectedType: "string", usedBy: "BillHistoryAction.Date" },
  { path: "Branch",     expectedType: "string", usedBy: "BillHistoryAction.Branch" },
  { path: "Action",     expectedType: "string", usedBy: "BillHistoryAction.Action" },
  { path: "IsStricken", expectedType: "boolean", optional: true, usedBy: "NOT in MAPLE type — silently dropped by runtypes" }
]

const MEMBER_SPECS: FieldSpec[] = [
  { path: "Name",               expectedType: "string", usedBy: "MemberContent.Name" },
  { path: "GeneralCourtNumber", expectedType: "number", usedBy: "MemberContent.GeneralCourtNumber" },
  { path: "MemberCode",         expectedType: "string", usedBy: "MemberContent.MemberCode" },
  { path: "LeadershipPosition", expectedType: "string", nullable: true, usedBy: "MemberContent.LeadershipPosition" },
  { path: "District",           expectedType: "string", nullable: true, usedBy: "MemberContent.District — null in old courts" },
  { path: "Party",              expectedType: "string", nullable: true, usedBy: "MemberContent.Party" },
  { path: "Branch",             expectedType: "string", nullable: true, usedBy: "MemberContent.Branch" },
  { path: "EmailAddress",       expectedType: "string", nullable: true, usedBy: "MemberContent.EmailAddress — null in old courts" },
  { path: "PhoneNumber",        expectedType: "string", nullable: true, usedBy: "MemberContent.PhoneNumber — null in old courts" },
  { path: "FaxNumber",          expectedType: "string", nullable: true, usedBy: "MemberContent.FaxNumber" },
  { path: "RoomNumber",         expectedType: "string", nullable: true, usedBy: "MemberContent.RoomNumber — null in old courts" },
  { path: "Committees",         expectedType: "array",  usedBy: "MemberContent.Committees" },
  { path: "SponsoredBills",     expectedType: "array",  usedBy: "justIds(SponsoredBills) — extracts BillNumber strings; empty in old courts" },
  { path: "CoSponsoredBills",   expectedType: "array",  usedBy: "justIds(CoSponsoredBills) — extracts BillNumber strings; empty in old courts" }
]

const SESSION_SPECS: FieldSpec[] = [
  { path: "EventId",            expectedType: "number", usedBy: "BaseEventContent.EventId" },
  { path: "EventDate",          expectedType: "string", usedBy: "BaseEventContent.EventDate — used to compute startsAt Timestamp" },
  { path: "StartTime",          expectedType: "string", usedBy: "BaseEventContent.StartTime — used to compute startsAt Timestamp" },
  { path: "GeneralCourtNumber", expectedType: "number", usedBy: "not in MAPLE type — for anomaly detection" },
  { path: "Name",               expectedType: "string", usedBy: "not stored by MAPLE — silently dropped" },
  { path: "Status",             expectedType: "string", usedBy: "not stored by MAPLE — silently dropped" },
  { path: "LocationName",       expectedType: "string", nullable: true, usedBy: "not stored by MAPLE — silently dropped" },
  { path: "Description",        expectedType: "string", nullable: true, usedBy: "not stored by MAPLE — silently dropped" }
]

const COMMITTEE_SPECS: FieldSpec[] = [
  { path: "CommitteeCode",           expectedType: "string", usedBy: "CommitteeContent.CommitteeCode" },
  { path: "FullName",                expectedType: "string", usedBy: "CommitteeContent.FullName" },
  { path: "HouseChairperson",        expectedType: "object", nullable: true, usedBy: "CommitteeContent.HouseChairperson" },
  { path: "HouseChairperson.MemberCode", expectedType: "string", optional: true, usedBy: "CommitteeContent.HouseChairperson.MemberCode — only when non-null" },
  { path: "SenateChairperson",       expectedType: "object", nullable: true, usedBy: "CommitteeContent.SenateChairperson" },
  { path: "SenateChairperson.MemberCode", expectedType: "string", optional: true, usedBy: "CommitteeContent.SenateChairperson.MemberCode — only when non-null" },
  { path: "DocumentsBeforeCommittee",expectedType: "array",  usedBy: "CommitteeContent.DocumentsBeforeCommittee — justIds() extracts strings" },
  { path: "ReportedOutDocuments",    expectedType: "array",  usedBy: "CommitteeContent.ReportedOutDocuments — justIds() extracts strings" },
  { path: "ShortName",               expectedType: "string", optional: true, usedBy: "NOT in MAPLE type — silently dropped" },
  { path: "Description",             expectedType: "string", optional: true, usedBy: "NOT in MAPLE type — silently dropped" },
  { path: "Branch",                  expectedType: "string", optional: true, usedBy: "NOT in MAPLE type — silently dropped" }
]

const HEARING_SPECS: FieldSpec[] = [
  { path: "EventId",                        expectedType: "number", usedBy: "BaseEventContent.EventId" },
  { path: "EventDate",                      expectedType: "string", usedBy: "BaseEventContent.EventDate" },
  { path: "StartTime",                      expectedType: "string", usedBy: "BaseEventContent.StartTime" },
  { path: "Description",                    expectedType: "string", usedBy: "HearingContent.Description — MAPLE type says non-null String, but API returns null for some hearings", note: "type mismatch: MAPLE stores null silently since getHearing() skips runtypes validation" },
  { path: "Name",                           expectedType: "string", nullable: true, usedBy: "HearingContent.Name" },
  { path: "Status",                         expectedType: "string", usedBy: "HearingContent.Status" },
  { path: "HearingHost",                    expectedType: "object", usedBy: "HearingContent.HearingHost" },
  { path: "HearingHost.CommitteeCode",      expectedType: "string", nullable: true, usedBy: "HearingContent.HearingHost.CommitteeCode" },
  { path: "HearingHost.GeneralCourtNumber", expectedType: "number", nullable: true, usedBy: "HearingContent.HearingHost.GeneralCourtNumber" },
  { path: "Location",                       expectedType: "object", usedBy: "HearingContent.Location" },
  { path: "Location.LocationName",          expectedType: "string", nullable: true, usedBy: "HearingLocation.LocationName" },
  { path: "Location.AddressLine1",          expectedType: "string", nullable: true, usedBy: "HearingLocation.AddressLine1" },
  { path: "Location.AddressLine2",          expectedType: "string", nullable: true, usedBy: "HearingLocation.AddressLine2" },
  { path: "Location.City",                  expectedType: "string", nullable: true, usedBy: "HearingLocation.City" },
  { path: "Location.State",                 expectedType: "string", nullable: true, usedBy: "HearingLocation.State" },
  { path: "Location.ZipCode",               expectedType: "string", nullable: true, usedBy: "HearingLocation.ZipCode" },
  { path: "HearingAgendas",                 expectedType: "array",  usedBy: "HearingContent.HearingAgendas" },
  { path: "RescheduledHearing",             expectedType: "object", nullable: true, usedBy: "HearingContent.RescheduledHearing" }
]

// ─── utilities ────────────────────────────────────────────────────────────────

function getNestedValue(obj: any, dotPath: string): { exists: boolean; value: unknown } {
  const parts = dotPath.split(".")
  let cur = obj
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      return { exists: false, value: undefined }
    }
    if (!(part in cur)) return { exists: false, value: undefined }
    cur = cur[part]
  }
  return { exists: true, value: cur }
}

function actualType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function truncate(value: unknown, maxLen = 80): unknown {
  if (typeof value === "string" && value.length > maxLen) {
    return value.slice(0, maxLen) + `…[${value.length} chars]`
  }
  if (Array.isArray(value)) {
    return `[array, ${value.length} items]`
  }
  return value
}

// ─── field checking ───────────────────────────────────────────────────────────

interface FieldResult {
  exists: boolean
  isNull: boolean
  typeOk: boolean
  actualType: string
  sampleValue: unknown
}

function checkField(obj: any, spec: FieldSpec): FieldResult {
  const { exists, value } = getNestedValue(obj, spec.path)
  const isNull = exists && value === null
  const at = actualType(value)
  const typeOk = !exists
    ? !!spec.optional
    : isNull
      ? !!spec.nullable
      : at === spec.expectedType

  return {
    exists,
    isNull,
    typeOk,
    actualType: at,
    sampleValue: truncate(value)
  }
}

interface SampleRecord {
  id: string
  fields: Record<string, FieldResult>
  error?: string
}

interface FieldAggregate {
  spec: FieldSpec
  presentCount: number   // exists and not null
  nullCount: number      // exists and is null
  absentCount: number    // does not exist
  typeErrorCount: number // exists but wrong type (and not nullable/optional)
  sampleValues: unknown[]
}

function aggregate(samples: SampleRecord[], specs: FieldSpec[]): Record<string, FieldAggregate> {
  const result: Record<string, FieldAggregate> = {}
  for (const spec of specs) {
    result[spec.path] = {
      spec,
      presentCount: 0,
      nullCount: 0,
      absentCount: 0,
      typeErrorCount: 0,
      sampleValues: []
    }
  }
  for (const sample of samples) {
    if (sample.error) continue
    for (const spec of specs) {
      const r = sample.fields[spec.path]
      if (!r) continue
      const agg = result[spec.path]
      if (!r.exists) agg.absentCount++
      else if (r.isNull) agg.nullCount++
      else agg.presentCount++
      if (!r.typeOk) agg.typeErrorCount++
      if (agg.sampleValues.length < 5 && r.exists && !r.isNull) {
        agg.sampleValues.push(r.sampleValue)
      }
    }
  }
  return result
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

async function get(apiPath: string, timeoutMs = 60_000): Promise<unknown> {
  const url = apiPath.startsWith("http")
    ? apiPath
    : `https://malegislature.gov/api/${apiPath.replace(/^\//, "")}`
  const r = await malegisAxios.get(url, { timeout: timeoutMs })
  return r.data
}

async function tryGet(apiPath: string, timeoutMs = 30_000): Promise<{ ok: true; data: unknown } | { ok: false; status: number | null; message: string }> {
  try {
    return { ok: true, data: await get(apiPath, timeoutMs) }
  } catch (e: any) {
    if (e.isAxiosError) {
      return { ok: false, status: e.response?.status ?? null, message: e.message }
    }
    throw e
  }
}

// ─── sampling ─────────────────────────────────────────────────────────────────

/** Pick exactly `n` items spread evenly across `list`, always including the
 *  first and last items. Uses i/(n-1) spacing so endpoints are in the budget. */
function spreadSample<T>(list: T[], n: number): T[] {
  if (list.length <= n) return list
  const picked = new Set<number>()
  for (let i = 0; i < n; i++) {
    picked.add(Math.round((i / (n - 1)) * (list.length - 1)))
  }
  return Array.from(picked).sort((a, b) => a - b).map(i => list[i])
}

// ─── resource validators ─────────────────────────────────────────────────────

interface ResourceReport {
  endpoint: string
  totalAvailable: number | null
  sampleSize: number
  successCount: number
  errorCount: number
  fieldSummary: Record<string, FieldAggregate>
  samples: SampleRecord[]
  listingErrors: string[]
  notes: string[]
}

async function validateBills(
  court: number,
  nSamples: number,
  console_: typeof console
): Promise<{ listing: ResourceReport; documents: ResourceReport; history: ResourceReport }> {
  console_.log("  [bills] fetching listing...")
  const listResult = await tryGet(`/GeneralCourts/${court}/Documents`, 90_000)
  if (!listResult.ok) {
    const empty = (endpoint: string): ResourceReport => ({
      endpoint,
      totalAvailable: null,
      sampleSize: 0,
      successCount: 0,
      errorCount: 0,
      fieldSummary: {},
      samples: [],
      listingErrors: [`HTTP ${listResult.status}: ${listResult.message}`],
      notes: []
    })
    return {
      listing: empty(`/GeneralCourts/${court}/Documents`),
      documents: empty(`/GeneralCourts/${court}/Documents/{id}`),
      history: empty(`/GeneralCourts/${court}/Documents/{id}/DocumentHistoryActions`)
    }
  }

  const allDocs = listResult.data as any[]
  const total = allDocs.length

  // Validate listing items
  const listingSamples: SampleRecord[] = spreadSample(allDocs, nSamples).map(doc => ({
    id: doc.BillNumber ?? doc.DocketNumber ?? "unknown",
    fields: Object.fromEntries(
      BILL_LISTING_SPECS.map(s => [s.path, checkField(doc, s)])
    )
  }))

  const listingReport: ResourceReport = {
    endpoint: `/GeneralCourts/${court}/Documents`,
    totalAvailable: total,
    sampleSize: listingSamples.length,
    successCount: listingSamples.length,
    errorCount: 0,
    fieldSummary: aggregate(listingSamples, BILL_LISTING_SPECS),
    samples: listingSamples,
    listingErrors: [],
    notes: []
  }

  // Choose a sample of bills with non-null BillNumber for full doc + history fetch
  const withBillNum = allDocs
    .filter(d => typeof d.BillNumber === "string" && d.BillNumber.length > 0)
  const docSample = spreadSample(withBillNum, nSamples)

  console_.log(`  [bills] fetching ${docSample.length} full documents + histories...`)

  const docSamples: SampleRecord[] = []
  const historySamples: SampleRecord[] = []

  for (const doc of docSample) {
    const billId = doc.BillNumber as string
    // Full document
    const fullResult = await tryGet(`/GeneralCourts/${court}/Documents/${billId}`)
    if (!fullResult.ok) {
      docSamples.push({ id: billId, fields: {}, error: `HTTP ${fullResult.status}: ${fullResult.message}` })
    } else {
      const full = fullResult.data as any
      docSamples.push({
        id: billId,
        fields: Object.fromEntries(
          BILL_DOCUMENT_SPECS.map(s => [s.path, checkField(full, s)])
        )
      })
    }

    // History (separate endpoint)
    const histResult = await tryGet(`/GeneralCourts/${court}/Documents/${billId}/DocumentHistoryActions`)
    if (!histResult.ok) {
      historySamples.push({ id: billId, fields: {}, error: `HTTP ${histResult.status}: ${histResult.message}` })
    } else {
      const actions = histResult.data as any[]
      if (actions.length === 0) {
        historySamples.push({ id: billId, fields: {}, error: "empty history array" })
      } else {
        // Check fields on the first (most recent) action
        historySamples.push({
          id: `${billId}[0]`,
          fields: Object.fromEntries(
            BILL_HISTORY_SPECS.map(s => [s.path, checkField(actions[0], s)])
          )
        })
      }
    }
  }

  const docErrors = docSamples.filter(s => s.error)
  const histErrors = historySamples.filter(s => s.error)

  return {
    listing: listingReport,
    documents: {
      endpoint: `/GeneralCourts/${court}/Documents/{id}`,
      totalAvailable: withBillNum.length,
      sampleSize: docSample.length,
      successCount: docSample.length - docErrors.length,
      errorCount: docErrors.length,
      fieldSummary: aggregate(docSamples, BILL_DOCUMENT_SPECS),
      samples: docSamples,
      listingErrors: docErrors.map(s => `${s.id}: ${s.error}`),
      notes: []
    },
    history: {
      endpoint: `/GeneralCourts/${court}/Documents/{id}/DocumentHistoryActions`,
      totalAvailable: null,
      sampleSize: historySamples.length,
      successCount: historySamples.length - histErrors.length,
      errorCount: histErrors.length,
      fieldSummary: aggregate(historySamples, BILL_HISTORY_SPECS),
      samples: historySamples,
      listingErrors: histErrors.map(s => `${s.id}: ${s.error}`),
      notes: []
    }
  }
}

async function validateMembers(
  court: number,
  nSamples: number,
  console_: typeof console
): Promise<ResourceReport> {
  console_.log("  [members] fetching listing...")
  const listResult = await tryGet(`/GeneralCourts/${court}/LegislativeMembers`, 60_000)
  if (!listResult.ok) {
    return {
      endpoint: `/GeneralCourts/${court}/LegislativeMembers/{code}`,
      totalAvailable: null, sampleSize: 0, successCount: 0, errorCount: 0,
      fieldSummary: {}, samples: [],
      listingErrors: [`HTTP ${listResult.status}: ${listResult.message}`],
      notes: []
    }
  }

  const allMembers = listResult.data as any[]
  const sample = spreadSample(allMembers, nSamples)
  console_.log(`  [members] fetching ${sample.length} full member records...`)

  const samples: SampleRecord[] = []
  for (const m of sample) {
    const code = m.MemberCode as string
    const result = await tryGet(`/GeneralCourts/${court}/LegislativeMembers/${code}`)
    if (!result.ok) {
      samples.push({ id: code, fields: {}, error: `HTTP ${result.status}: ${result.message}` })
    } else {
      const full = result.data as any
      // Normalize SponsoredBills / CoSponsoredBills so justIds() behaviour is visible
      samples.push({
        id: code,
        fields: Object.fromEntries(
          MEMBER_SPECS.map(s => [s.path, checkField(full, s)])
        )
      })
    }
  }

  const errors = samples.filter(s => s.error)
  return {
    endpoint: `/GeneralCourts/${court}/LegislativeMembers/{code}`,
    totalAvailable: allMembers.length,
    sampleSize: sample.length,
    successCount: sample.length - errors.length,
    errorCount: errors.length,
    fieldSummary: aggregate(samples, MEMBER_SPECS),
    samples,
    listingErrors: errors.map(s => `${s.id}: ${s.error}`),
    notes: []
  }
}

async function validateSessions(court: number, console_: typeof console): Promise<ResourceReport> {
  console_.log("  [sessions] fetching all...")
  const result = await tryGet(`/GeneralCourts/${court}/Sessions`, 60_000)
  if (!result.ok) {
    return {
      endpoint: `/GeneralCourts/${court}/Sessions`,
      totalAvailable: null, sampleSize: 0, successCount: 0, errorCount: 0,
      fieldSummary: {}, samples: [],
      listingErrors: [`HTTP ${result.status}: ${result.message}`],
      notes: []
    }
  }

  const sessions = result.data as any[]
  const samples: SampleRecord[] = sessions.map((s, i) => ({
    id: String(s.EventId ?? i),
    fields: Object.fromEntries(SESSION_SPECS.map(spec => [spec.path, checkField(s, spec)]))
  }))

  // Flag date anomalies (years way outside the expected range for this court)
  // court 192 = 2021-22, each court is 2 years; court N starts at 2021 - (192-N)*2
  const firstYear = 2021 - (192 - court) * 2
  const lastYear = firstYear + 1
  const anomalies = sessions.filter(s => {
    const d = s.EventDate ?? s.StartTime ?? ""
    if (!d) return false
    const y = new Date(d).getFullYear()
    return y < firstYear - 1 || y > lastYear + 1
  })

  const notes: string[] = []
  if (anomalies.length > 0) {
    notes.push(`${anomalies.length} sessions have EventDate outside expected range ${firstYear}–${lastYear}`)
    anomalies.slice(0, 3).forEach(a =>
      notes.push(`  EventId=${a.EventId} EventDate=${a.EventDate} (expected ${firstYear}–${lastYear})`)
    )
  }

  return {
    endpoint: `/GeneralCourts/${court}/Sessions`,
    totalAvailable: sessions.length,
    sampleSize: sessions.length,
    successCount: sessions.length,
    errorCount: 0,
    fieldSummary: aggregate(samples, SESSION_SPECS),
    samples,
    listingErrors: [],
    notes
  }
}

async function validateCommittees(court: number, console_: typeof console): Promise<ResourceReport> {
  console_.log("  [committees] fetching listing...")
  const listResult = await tryGet(`/GeneralCourts/${court}/Committees`, 60_000)
  if (!listResult.ok) {
    return {
      endpoint: `/GeneralCourts/${court}/Committees/{code}`,
      totalAvailable: null, sampleSize: 0, successCount: 0, errorCount: 0,
      fieldSummary: {}, samples: [],
      listingErrors: [`HTTP ${listResult.status}: ${listResult.message}`],
      notes: []
    }
  }

  const allCommittees = listResult.data as any[]
  console_.log(`  [committees] fetching all ${allCommittees.length} full committee records...`)

  const samples: SampleRecord[] = []
  for (const c of allCommittees) {
    const code = c.CommitteeCode as string
    const result = await tryGet(`/GeneralCourts/${court}/Committees/${code}`)
    if (!result.ok) {
      samples.push({ id: code, fields: {}, error: `HTTP ${result.status}: ${result.message}` })
    } else {
      samples.push({
        id: code,
        fields: Object.fromEntries(COMMITTEE_SPECS.map(s => [s.path, checkField(result.data, s)]))
      })
    }
  }

  const errors = samples.filter(s => s.error)
  return {
    endpoint: `/GeneralCourts/${court}/Committees/{code}`,
    totalAvailable: allCommittees.length,
    sampleSize: allCommittees.length,
    successCount: allCommittees.length - errors.length,
    errorCount: errors.length,
    fieldSummary: aggregate(samples, COMMITTEE_SPECS),
    samples,
    listingErrors: errors.map(s => `${s.id}: ${s.error}`),
    notes: []
  }
}

async function validateHearings(console_: typeof console): Promise<ResourceReport> {
  console_.log("  [hearings] fetching global listing...")
  const listResult = await tryGet(`/Hearings`, 60_000)
  if (!listResult.ok) {
    return {
      endpoint: `/Hearings/{id}`,
      totalAvailable: null, sampleSize: 0, successCount: 0, errorCount: 0,
      fieldSummary: {}, samples: [],
      listingErrors: [`HTTP ${listResult.status}: ${listResult.message}`],
      notes: []
    }
  }

  const allHearings = listResult.data as any[]
  // Sample 30 spread across the full list
  const sample = spreadSample(allHearings, 30)
  console_.log(`  [hearings] fetching ${sample.length} full hearing records...`)

  const samples: SampleRecord[] = []
  const courtCounts: Record<number, number> = {}

  for (const h of sample) {
    const id = h.EventId as number
    const result = await tryGet(`/Hearings/${id}`)
    if (!result.ok) {
      samples.push({ id: String(id), fields: {}, error: `HTTP ${result.status}: ${result.message}` })
    } else {
      const full = result.data as any
      const courtNum = full.HearingHost?.GeneralCourtNumber
      if (courtNum) courtCounts[courtNum] = (courtCounts[courtNum] ?? 0) + 1
      samples.push({
        id: String(id),
        fields: Object.fromEntries(HEARING_SPECS.map(s => [s.path, checkField(full, s)]))
      })
    }
  }

  const errors = samples.filter(s => s.error)
  const courtDist = Object.entries(courtCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([c, n]) => `court ${c}: ${n}`)
    .join(", ")

  return {
    endpoint: `/Hearings/{id}`,
    totalAvailable: allHearings.length,
    sampleSize: sample.length,
    successCount: sample.length - errors.length,
    errorCount: errors.length,
    fieldSummary: aggregate(samples, HEARING_SPECS),
    samples,
    listingErrors: errors.map(s => `${s.id}: ${s.error}`),
    notes: [
      "Hearings endpoint is global (not filtered by court). Sample spans all courts.",
      `Court distribution in this sample: ${courtDist || "unknown"}`
    ]
  }
}

// ─── reporting ────────────────────────────────────────────────────────────────

type StatusSymbol = "✓" | "⚠" | "✗"

function fieldStatus(agg: FieldAggregate, totalSamples: number): StatusSymbol {
  if (agg.spec.optional) return "✓"       // optional fields are always OK absent
  const effectiveSamples = totalSamples - agg.absentCount
  if (effectiveSamples === 0) return "✗"  // always absent when it shouldn't be
  if (agg.typeErrorCount > 0) return "⚠"
  if (agg.absentCount > 0) return "⚠"
  return "✓"
}

function renderMarkdown(
  court: number,
  timestamp: string,
  reports: Record<string, ResourceReport>
): string {
  const lines: string[] = []

  lines.push(`# Court ${court} Data Validation Report`)
  lines.push(`Generated: ${timestamp}\n`)

  // Top-level summary table
  lines.push("## Summary\n")
  lines.push("| Resource | Sampled | Errors | Field issues |")
  lines.push("|---|---|---|---|")
  for (const [name, report] of Object.entries(reports)) {
    const fieldIssues = Object.values(report.fieldSummary)
      .filter(a => fieldStatus(a, report.successCount) !== "✓")
      .map(a => a.spec.path)
      .join(", ") || "none"
    const errorStr = report.errorCount > 0 ? `**${report.errorCount}**` : "0"
    lines.push(`| ${name} | ${report.sampleSize} | ${errorStr} | ${fieldIssues} |`)
  }
  lines.push("")

  // Per-resource detail
  for (const [name, report] of Object.entries(reports)) {
    lines.push(`## ${name}`)
    lines.push(`**Endpoint:** \`${report.endpoint}\`  `)
    if (report.totalAvailable !== null) {
      lines.push(`**Total available:** ${report.totalAvailable}  `)
    }
    lines.push(`**Sampled:** ${report.sampleSize} (${report.successCount} ok, ${report.errorCount} errors)  `)
    lines.push("")

    if (report.notes.length > 0) {
      report.notes.forEach(n => lines.push(`> ${n}`))
      lines.push("")
    }

    if (report.listingErrors.length > 0) {
      lines.push("**Errors:**")
      report.listingErrors.slice(0, 5).forEach(e => lines.push(`- ${e}`))
      if (report.listingErrors.length > 5) {
        lines.push(`- … and ${report.listingErrors.length - 5} more`)
      }
      lines.push("")
    }

    if (Object.keys(report.fieldSummary).length === 0) {
      lines.push("_No field data collected (listing failed)._\n")
      continue
    }

    lines.push("| Status | Field | Used by | Present | Null | Absent | Type errors | Sample values |")
    lines.push("|---|---|---|---|---|---|---|---|")

    for (const [, agg] of Object.entries(report.fieldSummary)) {
      const status = fieldStatus(agg, report.successCount)
      const samples = agg.sampleValues.map(v => `\`${JSON.stringify(v)?.slice(0, 40)}\``).join(" · ") || "—"
      lines.push(
        `| ${status} | \`${agg.spec.path}\` | ${agg.spec.usedBy} | ${agg.presentCount} | ${agg.nullCount} | ${agg.absentCount} | ${agg.typeErrorCount} | ${samples} |`
      )
    }
    lines.push("")
  }

  return lines.join("\n")
}

// ─── console summary helper ───────────────────────────────────────────────────

function printSummary(court: number, reports: Record<string, ResourceReport>) {
  console.log("\n┌─────────────────────────────────────────────────────────┐")
  console.log(`│  Court ${court} validation complete`)
  console.log("├─────────────────────────────────────────────────────────┤")
  for (const [name, report] of Object.entries(reports)) {
    const issues = Object.values(report.fieldSummary)
      .filter(a => fieldStatus(a, report.successCount) !== "✓")
    const errStr = report.errorCount > 0 ? ` | ${report.errorCount} fetch errors` : ""
    const issueStr = issues.length > 0 ? ` | ${issues.length} field issue(s): ${issues.map(i => i.spec.path).join(", ")}` : ""
    const overallOk = report.errorCount === 0 && issues.length === 0
    console.log(`│  ${overallOk ? "✓" : "⚠"} ${name.padEnd(20)} ${report.sampleSize} sampled${errStr}${issueStr}`)
  }
  console.log("└─────────────────────────────────────────────────────────┘")
}

// ─── range helpers ────────────────────────────────────────────────────────────

interface CourtResult {
  court: number
  reports: Record<string, ResourceReport>
  mdPath: string
  jsonPath: string
}

function overallCourtStatus(reports: Record<string, ResourceReport>): StatusSymbol {
  const hasError = Object.values(reports).some(r => r.errorCount > 0)
  const hasFieldIssue = Object.values(reports).some(r =>
    Object.values(r.fieldSummary).some(a => fieldStatus(a, r.successCount) !== "✓")
  )
  if (hasError) return "✗"
  if (hasFieldIssue) return "⚠"
  return "✓"
}

function renderRangeSummary(
  results: CourtResult[],
  minCourt: number,
  maxCourt: number,
  billSamples: number,
  memberSamples: number,
  timestamp: string
): string {
  const RESOURCE_NAMES = [
    "Bill listing", "Bill documents", "Bill history",
    "Members", "Sessions", "Committees"
  ]
  const lines: string[] = []

  lines.push(`# Court Range ${minCourt}–${maxCourt} Validation Summary`)
  lines.push(`Generated: ${timestamp}`)
  lines.push(`Bill samples per court: ${billSamples} | Member samples: ${memberSamples}`)
  lines.push("")
  lines.push("> Hearings are excluded from range runs (global endpoint, not court-specific).")
  lines.push("> Run single-court mode on a representative court to validate hearing fields.")
  lines.push("")

  lines.push("## Status by Court\n")
  lines.push(`| Court | Overall | ${RESOURCE_NAMES.join(" | ")} |`)
  lines.push(`|---|---|${RESOURCE_NAMES.map(() => "---").join("|")}|`)

  for (const { court, reports } of results) {
    const overall = overallCourtStatus(reports)
    const cells = RESOURCE_NAMES.map(name => {
      const report = reports[name]
      if (!report) return "—"
      const issues = Object.values(report.fieldSummary)
        .filter(a => fieldStatus(a, report.successCount) !== "✓")
      const status: StatusSymbol = report.errorCount > 0 ? "✗" : issues.length > 0 ? "⚠" : "✓"
      const detail = report.errorCount > 0
        ? `${report.errorCount}err`
        : issues.length > 0 ? `${issues.length}warn` : ""
      return detail ? `${status} ${detail}` : status
    })
    lines.push(`| ${court} | ${overall} | ${cells.join(" | ")} |`)
  }
  lines.push("")

  lines.push("## Court Notes\n")
  let anyNotes = false
  for (const { court, reports, mdPath } of results) {
    const overall = overallCourtStatus(reports)
    if (overall === "✓") continue
    anyNotes = true
    lines.push(`### Court ${court} ${overall}`)
    for (const [name, report] of Object.entries(reports)) {
      if (report.errorCount > 0) {
        const sample = report.listingErrors.slice(0, 2).join("; ")
        lines.push(`- **${name}**: ${report.errorCount} fetch error(s) — ${sample}`)
      }
      const fieldIssues = Object.values(report.fieldSummary)
        .filter(a => fieldStatus(a, report.successCount) !== "✓")
      if (fieldIssues.length > 0) {
        lines.push(`- **${name}** field issues: ${fieldIssues.map(a => a.spec.path).join(", ")}`)
      }
      report.notes.forEach(n => lines.push(`- _${n}_`))
    }
    lines.push(`  → [Full detail](${path.basename(mdPath)})`)
    lines.push("")
  }
  if (!anyNotes) lines.push("_All courts passed with no issues._\n")

  lines.push("## Per-Court Detail Files\n")
  for (const { court, mdPath } of results) {
    lines.push(`- Court ${court}: [${path.basename(mdPath)}](${path.basename(mdPath)})`)
  }

  return lines.join("\n")
}

// ─── single-court runner ──────────────────────────────────────────────────────

async function runSingleCourt(court: number, billSamples: number, memberSamples: number) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const outDir = path.join(__dirname, "../validation-results")
  fs.mkdirSync(outDir, { recursive: true })
  const jsonPath = path.join(outDir, `court-${court}-${timestamp}.json`)
  const mdPath   = path.join(outDir, `court-${court}-${timestamp}.md`)

  console.log(`\nValidating court ${court}`)
  console.log(`Results will be written to:\n  ${jsonPath}\n  ${mdPath}\n`)

  const bills      = await validateBills(court, billSamples, console)
  const members    = await validateMembers(court, memberSamples, console)
  const sessions   = await validateSessions(court, console)
  const committees = await validateCommittees(court, console)
  const hearings   = await validateHearings(console)

  const reports: Record<string, ResourceReport> = {
    "Bill listing":   bills.listing,
    "Bill documents": bills.documents,
    "Bill history":   bills.history,
    "Members":        members,
    "Sessions":       sessions,
    "Committees":     committees,
    "Hearings":       hearings
  }

  fs.writeFileSync(jsonPath, JSON.stringify(
    { court, timestamp: new Date().toISOString(), billSamples, memberSamples, reports },
    null, 2
  ))
  fs.writeFileSync(mdPath, renderMarkdown(court, new Date().toISOString(), reports))

  printSummary(court, reports)
  console.log(`\nDetailed results written to:\n  ${mdPath}\n  ${jsonPath}\n`)
}

// ─── range runner ─────────────────────────────────────────────────────────────

async function runRange(
  minCourt: number,
  maxCourt: number,
  billSamples: number,
  memberSamples: number
) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const outDir = path.join(__dirname, "../validation-results")
  fs.mkdirSync(outDir, { recursive: true })

  const courts = Array.from({ length: maxCourt - minCourt + 1 }, (_, i) => minCourt + i)
  console.log(`\nValidating courts ${minCourt}–${maxCourt} (${courts.length} courts)`)
  console.log(`Bill samples per court: ${billSamples} | Member samples: ${memberSamples}`)
  console.log("Note: hearings validation is skipped in range mode (global endpoint).\n")

  const results: CourtResult[] = []

  for (const court of courts) {
    const sep = "═".repeat(62)
    console.log(`\n${sep}`)
    console.log(`  Court ${court}  (${results.length + 1}/${courts.length})`)
    console.log(sep)

    const courtTs  = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const jsonPath = path.join(outDir, `court-${court}-${courtTs}.json`)
    const mdPath   = path.join(outDir, `court-${court}-${courtTs}.md`)

    const bills      = await validateBills(court, billSamples, console)
    const members    = await validateMembers(court, memberSamples, console)
    const sessions   = await validateSessions(court, console)
    const committees = await validateCommittees(court, console)

    const reports: Record<string, ResourceReport> = {
      "Bill listing":   bills.listing,
      "Bill documents": bills.documents,
      "Bill history":   bills.history,
      "Members":        members,
      "Sessions":       sessions,
      "Committees":     committees
    }

    fs.writeFileSync(jsonPath, JSON.stringify(
      { court, timestamp: new Date().toISOString(), billSamples, memberSamples, reports },
      null, 2
    ))
    fs.writeFileSync(mdPath, renderMarkdown(court, new Date().toISOString(), reports))

    printSummary(court, reports)
    results.push({ court, reports, mdPath, jsonPath })
  }

  const rangeJsonPath = path.join(outDir, `range-${minCourt}-${maxCourt}-${timestamp}.json`)
  const rangeMdPath   = path.join(outDir, `range-${minCourt}-${maxCourt}-${timestamp}.md`)

  const rangeJson = {
    minCourt, maxCourt,
    timestamp: new Date().toISOString(),
    billSamples, memberSamples,
    courts: Object.fromEntries(results.map(({ court, reports, mdPath, jsonPath }) => [
      court,
      {
        overall: overallCourtStatus(reports),
        mdPath,
        jsonPath,
        resources: Object.fromEntries(Object.entries(reports).map(([name, report]) => [
          name,
          {
            sampleSize: report.sampleSize,
            errorCount: report.errorCount,
            fieldIssues: Object.values(report.fieldSummary)
              .filter(a => fieldStatus(a, report.successCount) !== "✓")
              .map(a => a.spec.path),
            notes: report.notes
          }
        ]))
      }
    ]))
  }
  fs.writeFileSync(rangeJsonPath, JSON.stringify(rangeJson, null, 2))
  fs.writeFileSync(rangeMdPath, renderRangeSummary(
    results, minCourt, maxCourt, billSamples, memberSamples, new Date().toISOString()
  ))

  const sep = "═".repeat(62)
  console.log(`\n${sep}`)
  console.log("  Range validation complete")
  console.log(sep)
  console.log(`\nRange summary:\n  ${rangeMdPath}\n  ${rangeJsonPath}`)
  console.log(`\nPer-court files in: ${outDir}/\n`)
}

// ─── main ────────────────────────────────────────────────────────────────────

export const script: Script = async ({ args }) => {
  const raw = args as Record<string, unknown>

  if (raw.court !== undefined) {
    const { court, billSamples, memberSamples } = SingleArgs.parse(raw)
    await runSingleCourt(court, billSamples, memberSamples)
  } else if (raw.minCourt !== undefined && raw.maxCourt !== undefined) {
    const { minCourt, maxCourt, billSamples, memberSamples } = RangeArgs.parse(raw)
    if (minCourt > maxCourt) throw new Error(`--minCourt ${minCourt} must be ≤ --maxCourt ${maxCourt}`)
    await runRange(minCourt, maxCourt, billSamples, memberSamples)
  } else {
    throw new Error(
      "Must specify either --court N  or  --minCourt N --maxCourt M\n" +
      "Run with --help to see all options."
    )
  }
}
