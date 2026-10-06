// Run: node scripts/sweep-orphans.js --dry   (report only)
//      node scripts/sweep-orphans.js         (delete)
// Removes room-scoped documents whose room no longer exists — covers
// non-transactional deletes that partially failed, and pre-existing junk.
require("dotenv").config();
const mongoose = require("mongoose");
const Room = require("../models/Room");
const User = require("../models/User");
const { ROOM_SCOPED } = require("../services/roomAdmin");

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const dry = process.argv.includes("--dry");
  const live = new Set((await Room.distinct("roomId")).map(String));

  for (const [name, Model] of Object.entries(ROOM_SCOPED)) {
    const dead = (await Model.distinct("roomId")).filter((id) => !live.has(String(id)));
    if (!dead.length) { console.log(`✔ ${name}: clean`); continue; }
    const n = dry
      ? await Model.countDocuments({ roomId: { $in: dead } })
      : (await Model.deleteMany({ roomId: { $in: dead } })).deletedCount;
    console.log(`${dry ? "would delete" : "deleted"} ${n} ${name} from ${dead.length} missing room(s)`);
  }

  const stale = (await User.distinct("joinedRooms")).filter((id) => !live.has(String(id)));
  if (stale.length) {
    if (!dry) await User.updateMany({ joinedRooms: { $in: stale } }, { $pull: { joinedRooms: { $in: stale } } });
    console.log(`${dry ? "would pull" : "pulled"} ${stale.length} stale joinedRooms id(s)`);
  } else console.log("✔ users.joinedRooms: clean");

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });