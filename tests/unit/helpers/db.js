// tests/unit/helpers/db.js
// One in-memory MongoDB per test file (Jest runs files in separate workers,
// so suites never share state). mongodb-memory-server downloads and caches a
// real `mongod` binary on first use; point MONGOMS_SYSTEM_BINARY at an
// existing binary if your environment can't reach fastdl.mongodb.org.
"use strict";
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod = null;

/** Boot an in-memory mongod and connect the app's mongoose instance to it. */
async function connect() {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("watch-party-test"));
}

/** Wipe every collection — run between tests so each starts from a blank DB. */
async function clearDatabase() {
  const collections = Object.values(mongoose.connection.collections);
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

/** Tear the whole thing down — run once per test file. */
async function disconnect() {
  await mongoose.disconnect();
  if (mongod) {
    await mongod.stop();
    mongod = null;
  }
}

module.exports = { connect, clearDatabase, disconnect };