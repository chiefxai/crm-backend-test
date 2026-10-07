// ============================================================
// services/vectorStore.js
//
// Real semantic search backing for the knowledge base (services/
// knowledgeBase.js), via a self-hosted Chroma server (CHROMA_URL, default
// http://localhost:8000 — run one with e.g.
// `docker run -p 8000:8000 chromadb/chroma`) and Gemini's embedding model
// for turning text into vectors. Replaces the previous substring
// `LIKE %query%` match in the old local shim, which wasn't doing any
// real search at all.
//
// One Chroma collection per workspace (`kb_<workspaceId>`), so workspaces never share
// vector space. If Chroma isn't reachable, every call here throws — the
// caller (knowledgeBase.js) is responsible for surfacing that clearly
// rather than silently falling back to fake results.
// ============================================================

const { ChromaClient } = require("chromadb");
const { scopeForOrg } = require("../workspaces/scope");
const genai = require("./googleAiClient");

const { isVertex } = genai;
const EMBEDDING_MODEL = isVertex ? "text-embedding-004" : "gemini-embedding-001";

class GeminiEmbeddingFunction {
  constructor(orgId) { this.orgId = orgId; }
  async generate(texts) {
    const aiClient = await genai.getClientForOrg(this.orgId);
    const res = await aiClient.models.embedContent({ model: EMBEDDING_MODEL, contents: texts });
    return (res.embeddings || []).map((e) => e.values);
  }
}

const embeddingFunctions = new Map();
function getEmbeddingFunction(orgId) {
  if (!embeddingFunctions.has(orgId)) embeddingFunctions.set(orgId, new GeminiEmbeddingFunction(orgId));
  return embeddingFunctions.get(orgId);
}

let client = null;
function getClient() {
  if (!client) {
    client = new ChromaClient({ path: process.env.CHROMA_URL || "http://localhost:8000" });
  }
  return client;
}

// Chroma collection names must be 3-63 chars, alphanumeric/underscore/
// hyphen, starting and ending alphanumeric — `kb_<uuid>` always satisfies
// that since org ids are uuids.
function collectionName(orgId) {
  return `kb_${scopeForOrg(orgId).workspaceId}`;
}

async function getCollection(orgId) {
  return getClient().getOrCreateCollection({ name: collectionName(orgId), embeddingFunction: getEmbeddingFunction(orgId) });
}

// Adds chunk texts for a document. `chunks` is [{ id, content }]; each id
// should be the corresponding knowledge_chunks row id so deletes can match
// by document.
async function addChunks(orgId, documentId, documentTitle, chunks) {
  if (!chunks.length) return;
  const collection = await getCollection(orgId);
  await collection.add({
    ids: chunks.map((c) => c.id),
    documents: chunks.map((c) => c.content),
    metadatas: chunks.map(() => ({ document_id: documentId, document_title: documentTitle }))
  });
}

async function deleteDocument(orgId, documentId) {
  const collection = await getCollection(orgId);
  await collection.delete({ where: { document_id: documentId } });
}

// documentIds, when given, restricts the search to only those documents —
// used when an agent is scoped to specific knowledge base documents rather
// than the org's whole knowledge base.
async function search(orgId, query, limit, documentIds = null) {
  const collection = await getCollection(orgId);
  const where = documentIds?.length ? { document_id: { "$in": documentIds } } : undefined;
  const result = await collection.query({ queryTexts: [query], nResults: limit, ...(where ? { where } : {}) });
  const documents = result.documents?.[0] || [];
  const metadatas = result.metadatas?.[0] || [];
  return documents.map((content, i) => ({
    content,
    documentTitle: metadatas[i]?.document_title || "Untitled"
  }));
}

module.exports = { addChunks, deleteDocument, search };
