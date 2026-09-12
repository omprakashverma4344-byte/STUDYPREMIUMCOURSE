import { MongoClient, ObjectId } from "mongodb";

const MODEL_COLLECTIONS = {
  App: "apps",
  Order: "orders",
  Access: "accesses",
  Admin: "admins",
  Settings: "settings",
  Visitor: "visitors",
  User: "users",
  BatchOwnership: "batchownerships",
  Donation: "donations",
  DonationPayment: "donationpayments",
  Coupon: "coupons",
  CourseLesson: "courselessons",
  Progress: "progress",
  Notification: "notifications",
  NotificationRead: "notificationreads",
  AuditLog: "auditlogs"
};

let client = null;
let db = null;
let connectPromise = null;

function clone(value) {
  if (value === undefined || value === null) return value;
  if (value instanceof Date) return new Date(value);
  if (value instanceof ObjectId) return new ObjectId(value);
  if (Array.isArray(value)) return value.map(clone);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clone(v);
    return out;
  }
  return value;
}

function isObjectIdLike(value) {
  return value instanceof ObjectId || (typeof value === "string" && ObjectId.isValid(value));
}

function castValue(value, definition) {
  if (value === undefined || value === null) return value;
  if (definition?.ref || definition?.type === ObjectId || definition?.type === Schema.Types.ObjectId) {
    if (isObjectIdLike(value)) return value instanceof ObjectId ? value : new ObjectId(value);
  }
  if (Array.isArray(value)) return value.map(v => castValue(v, definition?.type?.[0] || definition?.type));
  return value;
}

function getPath(obj, path) {
  return String(path).split(".").reduce((v, k) => v == null ? undefined : v[k], obj);
}

function setPath(obj, path, value) {
  const parts = String(path).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function deletePath(obj, path) {
  const parts = String(path).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur?.[parts[i]];
    if (!cur) return;
  }
  if (cur) delete cur[parts[parts.length - 1]];
}

function equalValues(a, b) {
  if (a instanceof ObjectId || b instanceof ObjectId) return String(a) === String(b);
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equalValues(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a), bk = Object.keys(b);
    return ak.length === bk.length && ak.every(k => Object.prototype.hasOwnProperty.call(b, k) && equalValues(a[k], b[k]));
  }
  return a === b;
}

function compare(a, b) {
  if (a instanceof ObjectId || b instanceof ObjectId) return String(a).localeCompare(String(b));
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() - new Date(b).getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function matchesField(value, condition) {
  if (condition instanceof RegExp) return condition.test(String(value ?? ""));
  if (condition && typeof condition === "object" && !Array.isArray(condition) && !(condition instanceof Date) && !(condition instanceof ObjectId)) {
    for (const [op, expected] of Object.entries(condition)) {
      if (op === "$in") {
        if (!Array.isArray(expected) || !expected.some(x => equalValues(value, x))) return false;
      } else if (op === "$nin") {
        if (Array.isArray(expected) && expected.some(x => equalValues(value, x))) return false;
      } else if (op === "$ne") {
        if (equalValues(value, expected)) return false;
      } else if (op === "$gt") {
        if (!(compare(value, expected) > 0)) return false;
      } else if (op === "$gte") {
        if (!(compare(value, expected) >= 0)) return false;
      } else if (op === "$lt") {
        if (!(compare(value, expected) < 0)) return false;
      } else if (op === "$lte") {
        if (!(compare(value, expected) <= 0)) return false;
      } else if (op === "$exists") {
        if (Boolean(value !== undefined) !== Boolean(expected)) return false;
      } else if (op === "$regex") {
        const flags = condition.$options || "";
        const re = expected instanceof RegExp ? expected : new RegExp(String(expected), flags);
        if (!re.test(String(value ?? ""))) return false;
      } else if (op === "$options") {
        continue;
      } else if (op === "$not") {
        if (matchesField(value, expected)) return false;
      } else {
        if (!equalValues(value, condition)) return false;
      }
    }
    return true;
  }
  return equalValues(value, condition);
}

function matches(doc, filter = {}) {
  for (const [key, condition] of Object.entries(filter || {})) {
    if (key === "$or") {
      if (!Array.isArray(condition) || !condition.some(x => matches(doc, x))) return false;
      continue;
    }
    if (key === "$and") {
      if (!Array.isArray(condition) || !condition.every(x => matches(doc, x))) return false;
      continue;
    }
    if (key === "$nor") {
      if (Array.isArray(condition) && condition.some(x => matches(doc, x))) return false;
      continue;
    }
    const value = getPath(doc, key);
    if (!matchesField(value, condition)) return false;
  }
  return true;
}

function applyProjection(doc, projection) {
  if (!projection) return clone(doc);
  const entries = Object.entries(projection);
  const include = entries.some(([k, v]) => k !== "_id" && v === 1);
  if (include) {
    const out = {};
    if (projection._id !== 0 && doc._id !== undefined) out._id = clone(doc._id);
    for (const [path, flag] of entries) if (flag === 1) {
      const value = getPath(doc, path);
      if (value !== undefined) setPath(out, path, clone(value));
    }
    return out;
  }
  const out = clone(doc);
  for (const [path, flag] of entries) if (flag === 0) deletePath(out, path);
  return out;
}

function parseSelect(select) {
  if (!select) return null;
  const out = {};
  for (const token of String(select).trim().split(/\s+/)) {
    if (!token) continue;
    out[token.startsWith("-") ? token.slice(1) : token] = token.startsWith("-") ? 0 : 1;
  }
  return out;
}

function getDefault(def) {
  if (!def || typeof def !== "object" || !Object.prototype.hasOwnProperty.call(def, "default")) return undefined;
  const value = def.default;
  return typeof value === "function" ? value() : clone(value);
}

function flattenSchema(definition, prefix = "", out = {}) {
  if (!definition || typeof definition !== "object") return out;
  for (const [key, value] of Object.entries(definition)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value) && !value.type && !value.default && !value.ref) {
      flattenSchema(value, path, out);
    } else {
      out[path] = value;
    }
  }
  return out;
}

function applyDefaults(doc, schema) {
  const flat = flattenSchema(schema?.definition || {});
  for (const [path, def] of Object.entries(flat)) {
    if (getPath(doc, path) === undefined) {
      const d = getDefault(def);
      if (d !== undefined) setPath(doc, path, d);
    }
  }
  if (schema?.options?.timestamps) {
    const now = new Date();
    if (doc.createdAt === undefined) doc.createdAt = now;
    if (doc.updatedAt === undefined) doc.updatedAt = now;
  }
  return doc;
}

function normalizeDocument(doc, model) {
  if (!doc) return doc;
  const out = clone(doc);
  Object.defineProperty(out, "save", {
    enumerable: false,
    value: async function save() {
      if (model.schema?.options?.timestamps) this.updatedAt = new Date();
      const payload = clone(this);
      delete payload.save;
      await model.collection.updateOne({ _id: this._id }, { $set: payload }, { upsert: false });
      return this;
    }
  });
  Object.defineProperty(out, "toObject", { enumerable: false, value: () => clone(out) });
  Object.defineProperty(out, "toJSON", { enumerable: false, value: () => clone(out) });
  return out;
}

class Query {
  constructor(model, operation, args = []) {
    this.model = model;
    this.operation = operation;
    this.args = args;
    this._sort = null;
    this._limit = null;
    this._projection = null;
    this._populates = [];
    this._lean = false;
  }
  sort(spec) { this._sort = spec; return this; }
  limit(n) { this._limit = Number(n); return this; }
  select(spec) { this._projection = typeof spec === "string" ? parseSelect(spec) : spec; return this; }
  populate(path, select) { this._populates.push({ path: typeof path === "string" ? path : path.path, select: typeof path === "string" ? select : path.select }); return this; }
  lean() { this._lean = true; return this; }
  async distinct(field) {
    const docs = await this.model.collection.find(this.args[0] || {}).toArray();
    const values = [...new Map(docs.map(d => [JSON.stringify(getPath(d, field)), getPath(d, field)])).values()];
    return values;
  }
  async exec() {
    const result = await this._run();
    return result;
  }
  then(resolve, reject) { return this.exec().then(resolve, reject); }
  catch(reject) { return this.exec().catch(reject); }
  finally(fn) { return this.exec().finally(fn); }

  async _run() {
    let result;
    const [arg0, arg1, arg2] = this.args;
    if (this.operation === "find") {
      let cursor = this.model.collection.find(arg0 || {});
      if (this._sort) cursor = cursor.sort(this._sort);
      if (this._limit != null) cursor = cursor.limit(this._limit);
      result = await cursor.toArray();
    } else if (this.operation === "findOne") {
      let cursor = this.model.collection.find(arg0 || {});
      if (this._sort) cursor = cursor.sort(this._sort);
      result = await cursor.limit(1).next();
    } else if (this.operation === "findById") {
      result = await this.model.collection.findOne({ _id: toObjectId(arg0) });
    } else if (this.operation === "findOneAndUpdate" || this.operation === "findByIdAndUpdate") {
      const filter = this.operation === "findByIdAndUpdate" ? { _id: toObjectId(arg0) } : (arg0 || {});
      const opts = arg2 || {};
      const update = arg1 || {};
      if (opts.upsert) {
        const existing = await this.model.collection.findOne(filter);
        if (!existing) {
          const base = applyDefaults({ ...clone(filter) }, this.model.schema);
          applyUpdate(base, update, true);
          if (this.model.schema?.options?.timestamps) {
            base.createdAt ||= new Date();
            base.updatedAt = new Date();
          }
          if (!base._id) base._id = new ObjectId();
          await this.model.collection.insertOne(base);
          result = opts.new ? base : null;
        } else {
          result = await updateOneAndReturn(this.model, filter, update, opts.new);
        }
      } else {
        result = await updateOneAndReturn(this.model, filter, update, opts.new);
      }
    } else if (this.operation === "findByIdAndDelete") {
      const found = await this.model.collection.findOne({ _id: toObjectId(arg0) });
      if (found) await this.model.collection.deleteOne({ _id: found._id });
      result = found;
    }

    if (Array.isArray(result)) result = result.map(x => this._finish(x));
    else result = this._finish(result);
    return result;
  }

  async _populateOne(doc, spec) {
    if (!doc || !spec?.path) return doc;
    const def = this.model.schema?.paths?.[spec.path];
    const ref = def?.ref;
    if (!ref) return doc;
    const target = models.get(ref);
    if (!target) return doc;
    const raw = getPath(doc, spec.path);
    if (raw == null) return doc;
    const ids = Array.isArray(raw) ? raw : [raw];
    const docs = await target.collection.find({ _id: { $in: ids.map(toObjectId) } }).toArray();
    const byId = new Map(docs.map(x => [String(x._id), x]));
    const selected = docs.map(x => applyProjection(x, parseSelect(spec.select)));
    const bySelectedId = new Map(selected.map(x => [String(x._id), x]));
    const populated = Array.isArray(raw) ? ids.map(id => bySelectedId.get(String(id))).filter(Boolean) : bySelectedId.get(String(raw));
    setPath(doc, spec.path, populated);
    return doc;
  }

  _finish(doc) {
    if (!doc) return doc;
    let out = this._projection ? applyProjection(doc, this._projection) : clone(doc);
    if (!this._lean) out = normalizeDocument(out, this.model);
    if (this._populates.length) {
      // Population is intentionally deferred; execute() already awaits this method only for non-populated paths.
      // A populated query is handled by QueryWithPopulate below.
    }
    return out;
  }
}

async function executeQuery(query) {
  let result = await query._run();
  if (!query._populates.length) return result;
  const populateDocs = async (doc) => {
    if (!doc) return doc;
    let out = doc;
    for (const spec of query._populates) {
      const def = query.model.schema?.paths?.[spec.path];
      const ref = def?.ref;
      const target = ref && models.get(ref);
      if (!target) continue;
      const raw = getPath(out, spec.path);
      if (raw == null) continue;
      const ids = Array.isArray(raw) ? raw : [raw];
      const docs = await target.collection.find({ _id: { $in: ids.map(toObjectId) } }).toArray();
      const projection = parseSelect(spec.select);
      const byId = new Map(docs.map(d => [String(d._id), applyProjection(d, projection)]));
      const populated = Array.isArray(raw) ? ids.map(id => byId.get(String(id))).filter(Boolean) : byId.get(String(raw));
      setPath(out, spec.path, populated);
    }
    return out;
  };
  if (Array.isArray(result)) return Promise.all(result.map(populateDocs));
  return populateDocs(result);
}

Query.prototype.exec = function execWithPopulate() { return executeQuery(this); };
Query.prototype.then = function thenWithPopulate(resolve, reject) { return this.exec().then(resolve, reject); };
Query.prototype.catch = function catchWithPopulate(reject) { return this.exec().catch(reject); };
Query.prototype.finally = function finallyWithPopulate(fn) { return this.exec().finally(fn); };

function toObjectId(value) {
  if (value instanceof ObjectId) return value;
  if (typeof value === "string" && ObjectId.isValid(value)) return new ObjectId(value);
  return value;
}

function castFilter(filter, schema) {
  if (!filter || typeof filter !== "object") return filter;
  const flat = schema?.paths || {};
  const walk = (node) => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(walk);
    const out = {};
    for (const [path, condition] of Object.entries(node)) {
      if (path === "$or" || path === "$and" || path === "$nor") {
        out[path] = Array.isArray(condition) ? condition.map(walk) : condition;
        continue;
      }
      const def = flat[path];
      if (def?.ref || def?.type === Schema.Types.ObjectId) {
        if (condition && typeof condition === "object" && !Array.isArray(condition) && !(condition instanceof ObjectId) && !(condition instanceof Date)) {
          const c = clone(condition);
          for (const op of ["$in", "$nin"]) if (Array.isArray(c[op])) c[op] = c[op].map(toObjectId);
          for (const op of ["$ne", "$gt", "$gte", "$lt", "$lte"]) if (c[op] !== undefined) c[op] = toObjectId(c[op]);
          out[path] = c;
        } else out[path] = toObjectId(condition);
      } else {
        out[path] = clone(condition);
      }
    }
    return out;
  };
  return walk(filter);
}

function applyUpdate(doc, update, isInsert = false) {
  if (!update || typeof update !== "object") return doc;
  const hasOperators = Object.keys(update).some(k => k.startsWith("$"));
  if (!hasOperators) {
    for (const [k, v] of Object.entries(update)) setPath(doc, k, clone(v));
    return doc;
  }
  if (update.$set) for (const [k, v] of Object.entries(update.$set)) setPath(doc, k, clone(v));
  if (isInsert && update.$setOnInsert) for (const [k, v] of Object.entries(update.$setOnInsert)) if (getPath(doc, k) === undefined) setPath(doc, k, clone(v));
  if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) setPath(doc, k, Number(getPath(doc, k) || 0) + Number(v));
  if (update.$unset) for (const k of Object.keys(update.$unset)) deletePath(doc, k);
  return doc;
}

async function updateOneAndReturn(model, filter, update, returnNew) {
  const casted = castFilter(filter, model.schema);
  const found = await model.collection.findOne(casted);
  if (!found) return null;
  const before = clone(found);
  const next = applyUpdate(found, update, false);
  if (model.schema?.options?.timestamps) next.updatedAt = new Date();
  await model.collection.replaceOne({ _id: found._id }, next);
  return returnNew ? next : before;
}

async function ensureConnected(uri) {
  if (db) return db;
  if (connectPromise) return connectPromise;
  connectPromise = (async () => {
    if (!uri) throw new Error("MONGODB_URI is missing");
    client = new MongoClient(uri, {
      // Cloudflare Workers can create many short-lived isolates. Keep the
      // pool deliberately small so analytics requests cannot exhaust it.
      maxPoolSize: 2,
      minPoolSize: 0,
      maxIdleTimeMS: 30000,
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
      socketTimeoutMS: 20000,
      waitQueueTimeoutMS: 10000,
      retryReads: true,
      retryWrites: true,
      family: 4
    });

    await client.connect();

    // Force an initial round-trip so a "connected" client is only accepted
    // after Atlas has actually answered.
    await client.db().command({ ping: 1 });

    db = client.db();
    return db;
  })().catch(error => {
    connectPromise = null;
    client = null;
    db = null;
    throw error;
  });
  return connectPromise;
}

const models = new Map();

class Schema {
  constructor(definition = {}, options = {}) {
    this.definition = definition;
    this.options = options;
    this.paths = flattenSchema(definition);
    for (const [path, def] of Object.entries(this.paths)) {
      if (def?.ref) this.paths[path] = { ...def };
    }
  }
  index() { return this; }
}
Schema.Types = { ObjectId, Mixed: Symbol("Mixed") };
Schema.Types.ObjectId = ObjectId;

function model(name, schema) {
  if (models.has(name)) return models.get(name);
  const collectionName = MODEL_COLLECTIONS[name] || `${name.toLowerCase()}s`;
  const wrapper = {
    modelName: name,
    schema,
    get collection() {
      if (!db) throw new Error("MongoDB is not connected");
      return db.collection(collectionName);
    },
    find(filter = {}) { return new Query(wrapper, "find", [castFilter(filter, schema)]); },
    findOne(filter = {}) { return new Query(wrapper, "findOne", [castFilter(filter, schema)]); },
    findById(id) { return new Query(wrapper, "findById", [toObjectId(id)]); },
    findOneAndUpdate(filter, update, options = {}) { return new Query(wrapper, "findOneAndUpdate", [castFilter(filter, schema), update, options]); },
    findByIdAndUpdate(id, update, options = {}) { return new Query(wrapper, "findByIdAndUpdate", [toObjectId(id), update, options]); },
    findByIdAndDelete(id) { return new Query(wrapper, "findByIdAndDelete", [toObjectId(id)]); },
    async create(input) {
      const data = applyDefaults(clone(input), schema);
      if (!data._id) data._id = new ObjectId();
      await wrapper.collection.insertOne(data);
      return normalizeDocument(data, wrapper);
    },
    async insertMany(inputs) {
      const docs = inputs.map(input => {
        const data = applyDefaults(clone(input), schema);
        if (!data._id) data._id = new ObjectId();
        return data;
      });
      if (docs.length) await wrapper.collection.insertMany(docs);
      return docs.map(d => normalizeDocument(d, wrapper));
    },
    async updateOne(filter, update, options = {}) {
      const casted = castFilter(filter, schema);
      const result = await wrapper.collection.updateOne(casted, update, options);
      return { acknowledged: result.acknowledged, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, upsertedId: result.upsertedId };
    },
    async updateMany(filter, update, options = {}) {
      const result = await wrapper.collection.updateMany(castFilter(filter, schema), update, options);
      return { acknowledged: result.acknowledged, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
    },
    async deleteMany(filter) { return wrapper.collection.deleteMany(castFilter(filter, schema)); },
    async countDocuments(filter = {}) { return wrapper.collection.countDocuments(castFilter(filter, schema)); },
    aggregate(pipeline = []) { return new Aggregate(wrapper, pipeline); },
    async exists(filter = {}) { return !!(await wrapper.collection.findOne(castFilter(filter, schema), { projection: { _id: 1 } })); }
  };
  models.set(name, wrapper);
  return wrapper;
}

class Aggregate {
  constructor(model, pipeline) { this.model = model; this.pipeline = pipeline; }
  async exec() { return this.model.collection.aggregate(this.pipeline).toArray(); }
  then(resolve, reject) { return this.exec().then(resolve, reject); }
  catch(reject) { return this.exec().catch(reject); }
  finally(fn) { return this.exec().finally(fn); }
}

const connection = {
  get readyState() { return db ? 1 : 0; }
};

export const mongoose = {
  Schema,
  model,
  Types: { ObjectId },
  connection,
  connections: [connection],
  isValidObjectId(value) { return ObjectId.isValid(value); },
  async connect(uri) { await ensureConnected(uri); return mongoose; },
  async disconnect() { if (client) await client.close(); client = null; db = null; connectPromise = null; }
};

export default mongoose;
