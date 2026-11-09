import assert from "node:assert/strict";
import test from "node:test";
import { mapGoogleError } from "../src/auth.js";
import {
  appendSuccess,
  appendToGoogleDoc,
  buildAppendRequest,
  documentUrl,
  planAppend,
  prepareAppendText,
  type DocSnapshot,
  type DocsApiClient,
} from "../src/docs.js";
import { extractDocumentId, ToolFailure, toFailurePayload } from "../src/validation.js";

const DOC_ID = "abcdefghijklmnopqrstuvwxyz123456";
const DOC_URL = `https://docs.google.com/document/d/${DOC_ID}/edit`;

const previousOauthCredentials = process.env.GOOGLE_OAUTH_CREDENTIALS_PATH;
const previousOauthToken = process.env.GOOGLE_OAUTH_TOKEN_PATH;
const previousCredentials = process.env.GOOGLE_CREDENTIALS_PATH;
const previousToken = process.env.GOOGLE_TOKEN_PATH;

test.afterEach(() => {
  restore("GOOGLE_OAUTH_CREDENTIALS_PATH", previousOauthCredentials);
  restore("GOOGLE_OAUTH_TOKEN_PATH", previousOauthToken);
  restore("GOOGLE_CREDENTIALS_PATH", previousCredentials);
  restore("GOOGLE_TOKEN_PATH", previousToken);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function paragraph(text: string): DocSnapshot {
  return {
    body: {
      content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }],
    },
  };
}

test("accepts a document ID and a Docs edit URL", () => {
  assert.equal(extractDocumentId(DOC_ID), DOC_ID);
  assert.equal(extractDocumentId(DOC_URL), DOC_ID);
  assert.equal(extractDocumentId(`https://docs.google.com/document/u/0/d/${DOC_ID}/edit?usp=sharing`), DOC_ID);
  assert.equal(documentUrl(DOC_ID), DOC_URL);
});

test("rejects an invalid document id or a non-Docs URL", () => {
  assert.throws(() => extractDocumentId("not a document"), (err: unknown) => {
    return err instanceof ToolFailure && err.code === "INVALID_DOCUMENT";
  });
  assert.throws(() => extractDocumentId("https://example.com/document/d/short/edit"), (err: unknown) => {
    return err instanceof ToolFailure && err.code === "INVALID_DOCUMENT";
  });
});

test("an empty document does not gain a leading blank line", () => {
  assert.equal(prepareAppendText("\n", "Weekly update\nCompleted the first milestone."), "Weekly update\nCompleted the first milestone.");
  assert.equal(prepareAppendText("\n", "\nWeekly update"), "Weekly update");

  const request = buildAppendRequest(planAppend(paragraph("\n"), "### Weekly update\nCompleted the first milestone."));
  assert.equal(request.requests.length, 1);
  assert.equal(request.requests[0]?.insertText.text, "### Weekly update\nCompleted the first milestone.");
  assert.deepEqual(request.requests[0]?.insertText.endOfSegmentLocation, {});
});

test("a nonempty document gets a separating newline and keeps existing text untouched", () => {
  const existing = "Notes from Monday\n";
  const content = "### Weekly update\nCompleted the first milestone.";
  const request = buildAppendRequest(planAppend(paragraph(existing), content));
  const inserted = request.requests[0]?.insertText.text;

  assert.equal(inserted, `\n${content}`);
  assert.equal(request.requests.length, 1);
  assert.equal(JSON.stringify(request).includes("deleteContentRange"), false);
  assert.equal(JSON.stringify(request).includes("replaceAllText"), false);
  assert.match(inserted ?? "", /### Weekly update/);
});

test("a second append is another insert, not a deduplicated update", () => {
  const first = buildAppendRequest(planAppend(paragraph("Notes from Monday\n"), "First note"));
  const afterFirst = "Notes from Monday\n\nFirst note\n";
  const second = buildAppendRequest(planAppend(paragraph(afterFirst), "First note"));
  assert.equal(second.requests[0]?.insertText.text, "\nFirst note");
  assert.notEqual(first.requests[0]?.insertText.text, "");
});

test("multiple tabs append to the first tab and say so", () => {
  const doc: DocSnapshot = {
    tabs: [
      {
        tabProperties: { tabId: "t.aaa", title: "Meeting" },
        documentTab: {
          body: { content: [{ paragraph: { elements: [{ textRun: { content: "Agenda\n" } }] } }] },
        },
      },
      {
        tabProperties: { tabId: "t.bbb", title: "Scratch" },
        documentTab: {
          body: { content: [{ paragraph: { elements: [{ textRun: { content: "Ignore\n" } }] } }] },
        },
      },
    ],
  };

  const plan = planAppend(doc, "Decision recorded");
  const request = buildAppendRequest(plan);
  assert.equal(plan.tabCount, 2);
  assert.equal(request.requests[0]?.insertText.endOfSegmentLocation.tabId, "t.aaa");
  assert.equal(request.requests[0]?.insertText.text, "\nDecision recorded");

  const success = appendSuccess(DOC_ID, plan);
  assert.equal(success.success, true);
  assert.equal(success.message, "Content appended successfully");
  assert.equal(success.documentId, DOC_ID);
  assert.match(success.note ?? "", /first tab/);
  assert.match(success.note ?? "", /Meeting/);
  assert.doesNotMatch(success.note ?? "", /Scratch/);
});

test("missing document permissions and missing authorization are not success", async () => {
  const missing = mapGoogleError(
    { code: 404, response: { data: { error: { status: "NOT_FOUND", message: "not found" } } } },
    "docs",
  );
  assert.equal(missing.code, "DOCUMENT_NOT_FOUND");
  assert.equal(toFailurePayload(missing).success, false);

  const denied = mapGoogleError(
    { code: 403, response: { data: { error: { status: "PERMISSION_DENIED", message: "forbidden" } } } },
    "docs",
  );
  assert.equal(denied.code, "DOCS_PERMISSION_DENIED");
  assert.equal(toFailurePayload(denied).success, false);

  process.env.GOOGLE_OAUTH_CREDENTIALS_PATH = "credentials/missing-client.json";
  process.env.GOOGLE_OAUTH_TOKEN_PATH = "credentials/missing-token.json";
  process.env.GOOGLE_CREDENTIALS_PATH = "credentials/missing-client.json";
  process.env.GOOGLE_TOKEN_PATH = "credentials/missing-token.json";
  await assert.rejects(
    () => appendToGoogleDoc({ documentId: DOC_URL, content: "Weekly update" }),
    (err: unknown) => err instanceof ToolFailure && err.code === "AUTH_MISSING" && toFailurePayload(err).success === false,
  );
});

function fakeDocs(existing: DocSnapshot): {
  client: DocsApiClient;
  updates: Array<{ documentId: string; requestBody: { requests: Array<{ insertText: { text: string } }> }; retry?: boolean }>;
  gets: number;
} {
  const updates: Array<{ documentId: string; requestBody: { requests: Array<{ insertText: { text: string } }> }; retry?: boolean }> = [];
  let gets = 0;
  return {
    updates,
    get gets() {
      return gets;
    },
    client: {
      documents: {
        get: async () => {
          gets += 1;
          return { data: existing };
        },
        batchUpdate: async (args, options) => {
          updates.push({ documentId: args.documentId, requestBody: args.requestBody, retry: options?.retry });
          return {};
        },
      },
    },
  };
}

test("a valid document ID performs one append insert and does not retry", async () => {
  const fake = fakeDocs(paragraph("Original content\n"));
  const result = await appendToGoogleDoc(
    { documentId: DOC_ID, content: "Weekly update\nCompleted the first milestone." },
    { docs: fake.client },
  );
  assert.equal(fake.gets, 1);
  assert.equal(fake.updates.length, 1);
  assert.equal(fake.updates[0]?.documentId, DOC_ID);
  assert.equal(fake.updates[0]?.retry, false);
  assert.equal(fake.updates[0]?.requestBody.requests.length, 1);
  assert.equal(
    fake.updates[0]?.requestBody.requests[0]?.insertText.text,
    "\nWeekly update\nCompleted the first milestone.",
  );
  assert.equal(result.success, true);
  assert.equal(result.documentUrl, DOC_URL);
});

test("a Docs URL is extracted and an invalid ID or empty note never calls the API", async () => {
  const fake = fakeDocs(paragraph("Original content\n"));
  await appendToGoogleDoc({ documentId: DOC_URL, content: "Appended content" }, { docs: fake.client });
  assert.equal(fake.updates[0]?.documentId, DOC_ID);

  const blocked = fakeDocs(paragraph("\n"));
  await assert.rejects(
    () => appendToGoogleDoc({ documentId: "https://example.com/not-a-doc", content: "Hello" }, { docs: blocked.client }),
    (err: unknown) => err instanceof ToolFailure && err.code === "INVALID_DOCUMENT",
  );
  await assert.rejects(
    () => appendToGoogleDoc({ documentId: DOC_ID, content: "  " }, { docs: blocked.client }),
    (err: unknown) => err instanceof ToolFailure && err.code === "INVALID_CONTENT",
  );
  assert.equal(blocked.gets, 0);
  assert.equal(blocked.updates.length, 0);
});

test("a Docs permission or rate-limit failure is not reported as success", async () => {
  const denied = fakeDocs(paragraph("Original content\n"));
  denied.client.documents.batchUpdate = async () => {
    throw { code: 403, response: { status: 403, data: { error: { status: "PERMISSION_DENIED", message: "forbidden" } } } };
  };
  await assert.rejects(
    () => appendToGoogleDoc({ documentId: DOC_ID, content: "Hello" }, { docs: denied.client }),
    (err: unknown) => err instanceof ToolFailure && err.code === "DOCS_PERMISSION_DENIED" && toFailurePayload(err).success === false,
  );

  const limited = mapGoogleError({ code: 429, message: "slow down" }, "docs");
  assert.equal(limited.code, "RATE_LIMITED");
  assert.equal(toFailurePayload(limited).success, false);
  assert.match(limited.message, /not retried/);
});
