/**
 * MongoDB connection holder and collection accessors for the whole gateway.
 *
 * Why: every route reaches the database through these getters so the active database name
 * (config/mode.js) is resolved in one place; a route can never hard-code a database and cross the
 * standard / preset_training boundary. Collections: businesses, doc_vectors (name overridable via
 * MONGODB_COLLECTION_NAME), ticket_logs, conversation_logs, admin_users, admin_sessions.
 *
 * Inputs: MONGODB_URI plus the mode variables. Outputs: lazily connected collection handles.
 * Callers: server.js (connectToDatabase at startup) and every router/middleware. Tests inject an
 * in-memory fake with setDatabaseAdapter(), so no test touches a real cluster.
 */
const path = require("path");
const { MongoClient } = require("mongodb");
const dotenv = require("dotenv");
const { PRESET_TENANTS, SAMPLE_TICKETS } = require("../config/presets");
const { resolveRuntimeConfig } = require("../config/mode");

// config/env.js (called first in server.js) already loads the repo-root and gateway .env.dev files,
// so the root load below only matters when this module is required without server.js. The second
// call is the only thing that loads a .env.dev from the process working directory, which
// tests/env_loading.test.js ("picks up a .env.dev in the working directory") depends on; dropping
// either call would need env.js to search process.cwd() first. The files are named ".env.dev"
// because the root ".env" is the Docker stack's configuration, not the host-run gateway's.
// override:false so explicit shell / Docker environment variables always win over file values.
const rootEnvPath = path.resolve(__dirname, "../../../.env.dev");
dotenv.config({ path: rootEnvPath, override: false });
dotenv.config({ path: path.resolve(process.cwd(), ".env.dev"), override: false });

let clientInstance = null;
let dbInstance = null;
let connectedDbName = null;
let customDbAdapter = null;

// Idempotent; run on every connect. The unique indexes enforce one business per tenant_id, one
// ticket per ticket_id, one admin per email / user_id and one session per token hash.
async function ensureIndexes(db) {
    const businesses = db.collection("businesses");
    await businesses.createIndex({ tenant_id: 1 }, { unique: true });

    const ticketLogs = db.collection("ticket_logs");
    await ticketLogs.createIndex({ ticket_id: 1 }, { unique: true });
    await ticketLogs.createIndex({ tenant_id: 1, status: 1, created_at: -1 });

    // Optional research log (see chat/conversationLog.js); stays empty unless a tenant opts in.
    const conversationLogs = db.collection("conversation_logs");
    await conversationLogs.createIndex({ tenant_id: 1, created_at: -1 });
    await conversationLogs.createIndex({ conversation_id: 1 });

    const adminUsers = db.collection("admin_users");
    await adminUsers.createIndex({ email: 1 }, { unique: true });
    await adminUsers.createIndex({ user_id: 1 }, { unique: true });
    await adminUsers.createIndex({ tenant_id: 1 });

    const adminSessions = db.collection("admin_sessions");
    await adminSessions.createIndex({ session_id_hash: 1 }, { unique: true });
    await adminSessions.createIndex({ expires_at: 1 });
}

// Only ever called in preset_training mode. $setOnInsert plus upsert keeps seeding idempotent and
// guarantees a restart never overwrites edits made to the preset tenants or tickets.
async function seedPresetTrainingData(db) {
    const businesses = db.collection("businesses");
    const ticketLogs = db.collection("ticket_logs");
    const nowIso = new Date().toISOString();

    for (const tenant of PRESET_TENANTS) {
        const { source_dir, source_documents, ...businessRecord } = tenant;
        await businesses.updateOne(
            { tenant_id: tenant.tenant_id },
            {
                $setOnInsert: {
                    ...businessRecord,
                    updated_at: nowIso,
                },
            },
            { upsert: true }
        );
    }

    for (const ticket of SAMPLE_TICKETS) {
        await ticketLogs.updateOne(
            { ticket_id: ticket.ticket_id },
            {
                $setOnInsert: {
                    ...ticket,
                    updated_at: nowIso,
                },
            },
            { upsert: true }
        );

        // Backfill for tickets seeded by an older version that had no transcript or contact fields;
        // $setOnInsert above never touches a ticket that already exists.
        await ticketLogs.updateOne(
            {
                ticket_id: ticket.ticket_id,
                messages: { $exists: false },
            },
            {
                $set: {
                    customer_contact: ticket.customer_contact,
                    escalation_reason: ticket.escalation_reason,
                    ticket_summary: ticket.ticket_summary,
                    messages: ticket.messages,
                },
            }
        );
    }
}

async function initializeDatabaseForMode(db, appMode) {
    await ensureIndexes(db);
    if (appMode === "preset_training") {
        await seedPresetTrainingData(db);
    }
}

function setDatabaseAdapter(adapter) {
    customDbAdapter = adapter;
}

function resetDatabaseAdapter() {
    customDbAdapter = null;
}

// Reconnects only when the active database name changes; the MongoClient itself is shared.
// Placeholder URIs from .env.dev.example are rejected up front so the failure message is actionable.
async function connectToDatabase(env = process.env) {
    const runtimeConfig = resolveRuntimeConfig(env);
    const { appMode, activeDbName } = runtimeConfig;

    if (customDbAdapter) {
        const db =
            typeof customDbAdapter.getDbForName === "function"
                ? customDbAdapter.getDbForName(activeDbName)
                : customDbAdapter;
        await initializeDatabaseForMode(db, appMode);
        return { client: null, db, runtimeConfig };
    }

    if (dbInstance && clientInstance && connectedDbName === activeDbName) {
        return { client: clientInstance, db: dbInstance, runtimeConfig };
    }

    const mongoUri = env.MONGODB_URI;
    if (
        !mongoUri ||
        mongoUri.includes("<username>") ||
        mongoUri.includes("<password>")
    ) {
        throw new Error(
            "MONGODB_URI is missing or contains placeholder values. Check your root .env.dev file (see .env.dev.example) or, in Docker, the root .env file."
        );
    }

    if (!clientInstance) {
        clientInstance = new MongoClient(mongoUri, {
            serverSelectionTimeoutMS: 8000,
            connectTimeoutMS: 8000,
        });
        await clientInstance.connect();
    }

    dbInstance = clientInstance.db(activeDbName);
    connectedDbName = activeDbName;

    await initializeDatabaseForMode(dbInstance, appMode);

    return { client: clientInstance, db: dbInstance, runtimeConfig };
}

async function getDb() {
    const { activeDbName } = resolveRuntimeConfig(process.env);
    if (customDbAdapter) {
        return typeof customDbAdapter.getDbForName === "function"
            ? customDbAdapter.getDbForName(activeDbName)
            : customDbAdapter;
    }
    if (!dbInstance || connectedDbName !== activeDbName) {
        await connectToDatabase(process.env);
    }
    return dbInstance;
}

async function getBusinessesCollection() {
    const db = await getDb();
    return db.collection("businesses");
}

async function getDocVectorsCollection() {
    const db = await getDb();
    const collectionName = process.env.MONGODB_COLLECTION_NAME || "doc_vectors";
    return db.collection(collectionName);
}

async function getTicketLogsCollection() {
    const db = await getDb();
    return db.collection("ticket_logs");
}

async function getConversationLogsCollection() {
    const db = await getDb();
    return db.collection("conversation_logs");
}

async function getAdminUsersCollection() {
    const db = await getDb();
    return db.collection("admin_users");
}

async function getAdminSessionsCollection() {
    const db = await getDb();
    return db.collection("admin_sessions");
}

async function closeDatabase() {
    if (clientInstance) {
        await clientInstance.close();
        clientInstance = null;
        dbInstance = null;
        connectedDbName = null;
    }
}

module.exports = {
    connectToDatabase,
    initializeDatabaseForMode,
    getDb,
    getBusinessesCollection,
    getDocVectorsCollection,
    getTicketLogsCollection,
    getConversationLogsCollection,
    getAdminUsersCollection,
    getAdminSessionsCollection,
    closeDatabase,
    setDatabaseAdapter,
    resetDatabaseAdapter,
};
