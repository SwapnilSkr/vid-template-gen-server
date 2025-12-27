/**
 * Mock data seeder for development
 * Creates Stewie, Peter characters and Minecraft template
 */
import { Types } from "mongoose";
import { Character, Template } from "../models";
import { connectDatabase } from "../db";

const MOCK_CHARACTERS = [
  {
    name: "stewie",
    displayName: "Stewie Griffin",
    voiceId: "stewie_voice_id", // Replace with real ElevenLabs voice ID
    imageUrl: "https://placeholder.com/stewie.png", // Replace with S3 URL
    position: {
      x: 15,
      y: 75,
      scale: 0.25,
      anchor: "bottom-left" as const,
    },
  },
  {
    name: "peter",
    displayName: "Peter Griffin",
    voiceId: "peter_voice_id", // Replace with real ElevenLabs voice ID
    imageUrl: "https://placeholder.com/peter.png", // Replace with S3 URL
    position: {
      x: 85,
      y: 75,
      scale: 0.3,
      anchor: "bottom-right" as const,
    },
  },
];

const MOCK_TEMPLATE = {
  name: "Minecraft Parkour",
  description: "Satisfying Minecraft parkour gameplay footage",
  videoUrl:
    "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4", // Replace with S3 URL
  duration: 60,
  dimensions: {
    width: 1920,
    height: 1080,
  },
  frameRate: 30,
};

export async function seedMockData(): Promise<void> {
  console.log("🌱 Seeding mock data...");

  // Create characters
  const characterIds: Types.ObjectId[] = [];

  for (const charData of MOCK_CHARACTERS) {
    let character = await Character.findOne({ name: charData.name });

    if (!character) {
      character = new Character(charData);
      await character.save();
      console.log(`  ✅ Created character: ${charData.displayName}`);
    } else {
      console.log(`  ⏭️  Character exists: ${charData.displayName}`);
    }

    characterIds.push(character._id);
  }

  // Create template with characters
  let template = await Template.findOne({ name: MOCK_TEMPLATE.name });

  if (!template) {
    template = new Template({
      ...MOCK_TEMPLATE,
      characters: characterIds,
    });
    await template.save();
    console.log(`  ✅ Created template: ${MOCK_TEMPLATE.name}`);
  } else {
    // Update characters if template exists
    template.characters = characterIds;
    await template.save();
    console.log(`  ⏭️  Template exists: ${MOCK_TEMPLATE.name}`);
  }

  console.log("🌱 Mock data seeded successfully!");
  console.log("");
  console.log("📋 Mock Data Summary:");
  console.log(`   Template ID: ${template._id}`);
  console.log("   Characters:");
  for (const char of await Character.find()) {
    console.log(`     - ${char.displayName} (${char.name}): ${char._id}`);
  }
}

// Run if executed directly
if (import.meta.main) {
  connectDatabase()
    .then(seedMockData)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Seeding failed:", error);
      process.exit(1);
    });
}
