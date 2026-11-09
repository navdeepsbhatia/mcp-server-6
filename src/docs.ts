/**
 * Append plain text to the end of an existing Google Doc.
 * The only write is insertText at the end of the segment. Existing content is not replaced.
 */
import { google } from "googleapis";
import { getAuthClient, mapGoogleError, noWriteRetry } from "./auth.js";
import {
  extractDocumentId,
  ToolFailure,
  validateAppendContent,
  type AppendInput,
} from "./validation.js";

interface StructuralElement {
  paragraph?: { elements?: Array<{ textRun?: { content?: string | null } | null }> | null } | null;
  table?: {
    tableRows?: Array<{
      tableCells?: Array<{ content?: StructuralElement[] | null }> | null;
    }> | null;
  } | null;
  tableOfContents?: { content?: StructuralElement[] | null } | null;
}

export interface DocSnapshot {
  body?: { content?: StructuralElement[] | null } | null;
  tabs?: Array<{
    tabProperties?: { tabId?: string | null; title?: string | null } | null;
    documentTab?: { body?: { content?: StructuralElement[] | null } | null } | null;
  }> | null;
}

export interface AppendPlan {
  text: string;
  tabId?: string;
  tabCount: number;
  firstTabTitle?: string;
}

export interface DocsAppendRequest {
  requests: Array<{
    insertText: {
      endOfSegmentLocation: { tabId?: string };
      text: string;
    };
  }>;
}

export interface DocsSuccess {
  success: true;
  message: "Content appended successfully";
  documentId: string;
  documentUrl: string;
  note?: string;
}

/** Walk paragraphs and tables so a table-only document is not treated as empty. */
function collectText(content: StructuralElement[] | null | undefined): string {
  let text = "";
  for (const element of content ?? []) {
    for (const child of element.paragraph?.elements ?? []) {
      text += child.textRun?.content ?? "";
    }
    for (const row of element.table?.tableRows ?? []) {
      for (const cell of row.tableCells ?? []) {
        text += collectText(cell.content);
      }
    }
    text += collectText(element.tableOfContents?.content);
  }
  return text;
}

function hasVisibleText(text: string): boolean {
  return text.replace(/\n/g, "").trim().length > 0;
}

/**
 * endOfSegmentLocation inserts immediately before the segment's final newline.
 * A nonempty document needs a leading newline so the note does not glue to the last line.
 * An empty document must not gain a blank first line.
 */
export function prepareAppendText(existingText: string, content: string): string {
  if (!hasVisibleText(existingText)) {
    return content.replace(/^\n/, "");
  }
  return content.startsWith("\n") ? content : `\n${content}`;
}

/** Decide the inserted text and, when the doc has tabs, the first tab only. */
export function planAppend(doc: DocSnapshot, content: string): AppendPlan {
  const validated = validateAppendContent(content);
  const tabs = doc.tabs ?? [];
  if (tabs.length > 0) {
    const first = tabs[0];
    const existing = collectText(first?.documentTab?.body?.content);
    const title = first?.tabProperties?.title ?? undefined;
    const tabId = first?.tabProperties?.tabId ?? undefined;
    return {
      text: prepareAppendText(existing, validated),
      tabId: tabId ?? undefined,
      tabCount: tabs.length,
      firstTabTitle: title ?? undefined,
    };
  }

  return {
    text: prepareAppendText(collectText(doc.body?.content), validated),
    tabCount: 1,
  };
}

/** One insert at the end of the body. No delete or replace request is ever added. */
export function buildAppendRequest(plan: AppendPlan): DocsAppendRequest {
  return {
    requests: [
      {
        insertText: {
          endOfSegmentLocation: plan.tabId ? { tabId: plan.tabId } : {},
          text: plan.text,
        },
      },
    ],
  };
}

export function documentUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

export function appendSuccess(documentId: string, plan: AppendPlan): DocsSuccess {
  const success: DocsSuccess = {
    success: true,
    message: "Content appended successfully",
    documentId,
    documentUrl: documentUrl(documentId),
  };
  if (plan.tabCount > 1) {
    const title = plan.firstTabTitle ? ` ("${plan.firstTabTitle}")` : "";
    success.note = `Appended to the first tab${title}. This version always uses the first tab. A tabId argument may be added later.`;
  }
  return success;
}

export interface DocsApiClient {
  documents: {
    get: (args: { documentId: string; includeTabsContent?: boolean }) => Promise<{ data: DocSnapshot }>;
    batchUpdate: (
      args: { documentId: string; requestBody: DocsAppendRequest },
      options?: { retry?: boolean },
    ) => Promise<unknown>;
  };
}

/** Validate, authorize, read the doc, and append. A repeat call appends again. */
export async function appendToGoogleDoc(
  input: AppendInput,
  deps?: { docs?: DocsApiClient },
): Promise<DocsSuccess> {
  const documentId = extractDocumentId(input.documentId);
  validateAppendContent(input.content);
  const docs = deps?.docs ?? (await realDocsClient());

  try {
    const current = await docs.documents.get({
      documentId,
      includeTabsContent: true,
    });
    const plan = planAppend(current.data as DocSnapshot, input.content);
    await docs.documents.batchUpdate(
      {
        documentId,
        requestBody: buildAppendRequest(plan),
      },
      noWriteRetry,
    );
    return appendSuccess(documentId, plan);
  } catch (err) {
    if (err instanceof ToolFailure) throw err;
    throw mapGoogleError(err, "docs");
  }
}

async function realDocsClient(): Promise<DocsApiClient> {
  const auth = await getAuthClient();
  return google.docs({ version: "v1", auth }) as unknown as DocsApiClient;
}
