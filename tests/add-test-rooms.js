// Make sure you're logged in first — cookies must exist (credentials: 'include')
const NUM_ROOMS = 30;

const random = (arr) => arr[Math.floor(Math.random() * arr.length)];

const modes = ["study", "gaming", "entertainment", "casual"];
const tagsList = [
  "chill", "focus", "music", "coding", "anime", "movie", "friends",
  "fun", "strategy", "hangout", "solo", "group", "productive"
];

// Helper to generate a random room
function generateRoom(i) {
  const type = random(modes);
  const name = `${type.charAt(0).toUpperCase() + type.slice(1)} Room #${i + 1}`;
  const desc = [
    "Join and vibe together!",
    "Casual place to hang out.",
    "Focus and study together.",
    "Watch something fun!",
    "Collaborate and chill."
  ];

  return {
    roomName: name,
    description: random(desc),
    mode: type,
    maxParticipants: Math.floor(Math.random() * 10) + 5,
    isPublic: true,
    tags: Array.from(
      { length: 3 },
      () => random(tagsList)
    ),
    thumbnail: "https://images.pexels.com/photos/1563356/pexels-photo-1563356.jpeg",
    video: {
      "url": "https://cdn.pixabay.com/video/2025/09/15/304330_large.mp4",
      "title": "Ambient Study Background",
      "currentTime": 0,
      "duration": null,
      "isPlaying": false
    }
  };
}

// Function to create rooms sequentially
async function createRooms() {
  for (let i = 0; i < NUM_ROOMS; i++) {
    const roomData = generateRoom(i);
    try {
      const res = await fetch("http://localhost:5000/api/rooms/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(roomData)
      });

      const data = await res.json();
      if (res.ok) {
        console.log(`✅ Created room ${i + 1}: ${data.room.roomName}`);
      } else {
        console.error(`❌ Failed (${i + 1}):`, data);
      }
    } catch (err) {
      console.error(`⚠️ Error creating room ${i + 1}:`, err);
    }
  }

  console.log(`🎉 Done creating ${NUM_ROOMS} test rooms.`);
}

// Run it
createRooms();

// NOTE: RUN ON FRONTEND CONSOLE< YOU'RE NOT LOGGED IN HERE