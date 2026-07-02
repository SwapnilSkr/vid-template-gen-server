import { Schema, model, type Document, type Types } from "mongoose";

// ============================================
// StoryBank — a queue of ready-to-film Reddit-style stories, kept fresh by a
// scheduled top-up job. Sourcing is pluggable (see story.service.ts):
//   llm      — LLM invents an original story from a theme
//   hybrid   — real Reddit post used as INSPIRATION, LLM rewrites it original
//   verbatim — real Reddit post narrated near word-for-word
// `premiseKey` dedupes so we never repeat a premise; `used` marks consumed.
// ============================================

export type StorySource = "llm" | "hybrid" | "verbatim";

export interface IStory extends Document {
  _id: Types.ObjectId;
  title: string;
  body: string;
  source: StorySource;
  theme?: string; // e.g. "twisted_family"
  genre?: string; // e.g. "aita_family"
  subreddit?: string; // e.g. "r/AmItheAsshole"
  author?: string; // original reddit author, only displayed for verbatim stories
  upvotes?: number;
  comments?: number;
  ageHours?: number;
  seedTitle?: string; // original reddit title (hybrid/verbatim)
  seedUrl?: string; // original reddit permalink (hybrid/verbatim)
  premiseKey: string; // normalized dedupe key
  used: boolean;
  usedAt?: Date;
  reelId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const storySchema = new Schema<IStory>(
  {
    title: { type: String, required: true },
    body: { type: String, required: true },
    source: { type: String, enum: ["llm", "hybrid", "verbatim"], required: true },
    theme: String,
    genre: String,
    subreddit: String,
    author: String,
    upvotes: Number,
    comments: Number,
    ageHours: Number,
    seedTitle: String,
    seedUrl: String,
    premiseKey: { type: String, required: true, index: true },
    used: { type: Boolean, default: false, index: true },
    usedAt: Date,
    reelId: { type: Schema.Types.ObjectId, ref: "Reel" },
  },
  { timestamps: true }
);

export const Story = model<IStory>("Story", storySchema);
