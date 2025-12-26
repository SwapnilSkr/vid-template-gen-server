# Templated AI Video Generator

A production-ready SaaS API for generating templated AI videos. This service allows users to combine base video templates (e.g., Minecraft gameplay) with AI-generated characters, dialogue, and voiceovers.

## 🚀 Features

- **One-Command Generation**: Generate full videos with a single API call containing just a template ID and plot.
- **AI Script Generation**: Uses OpenRouter (OpenAI, etc.) to generate dialogue scripts from user plots.
- **Voice Synthesis**: Integrates with ElevenLabs for high-quality character voices.
- **Dynamic Composition**: Uses FFmpeg to overlay characters, merge audio, and burn subtitles.
- **Cloud Storage**: Stores all assets (videos, images, subtitles) on AWS S3.
- **Persistent Data**: Uses MongoDB for storing templates, characters, and job status.
- **Production Ready**: Dockerized setup with full TypeScript support.

## 🛠️ Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Framework**: [ElysiaJS](https://elysiajs.com)
- **Database**: MongoDB (Mongoose)
- **Storage**: AWS S3
- **AI/ML**:
  - OpenRouter (Scripting)
  - ElevenLabs (TTS)
  - FFmpeg (Video Processing)

## 📦 Prerequisites

- **Bun** (v1.0+)
- **MongoDB** (Local or Atlas)
- **AWS S3 Bucket**
- **API Keys**:
  - OpenRouter (for LLM)
  - ElevenLabs (for Voices)
  - AWS Credentials

## 🏃‍♂️ Getting Started

### 1. Installation

```bash
cd server
bun install
```

### 2. Configuration

Create a `.env.local` file in the `server` directory:

```env
# Server
PORT=3000

# Database
MONGODB_URI=mongodb://localhost:27017/video-generator

# AWS S3
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_aws_key
AWS_SECRET_ACCESS_KEY=your_aws_secret
S3_BUCKET=your-bucket-name

# AI Services
OPENROUTER_API_KEY=your_openrouter_key
OPENROUTER_MODEL=openai/gpt-4o-mini
ELEVEN_LABS_API_KEY=your_elevenlabs_key

# Local Processing (Optional overrides)
# STORAGE_PATH=./storage
```

### 3. Seed Mock Data

Populate the database with sample characters (Stewie, Peter) and a template:

```bash
bun run seed
```

### 4. Run Development Server

```bash
bun run dev
```

Server will be running at `http://localhost:3000`.

## 🐳 Docker Support

To run the full stack with Docker (includes FFmpeg):

```bash
docker compose up --build
```

---

## 📚 API Examples

### 1. Create Characters

Manually upload character images and define their voice/position.

```bash
# Stewie
curl -X POST http://localhost:3000/api/characters \
  -F "image=@stewie.png" \
  -F "name=stewie" \
  -F "displayName=Stewie Griffin" \
  -F "voiceId=YOUR_ELEVENLABS_VOICE_ID" \
  -F "positionX=15" \
  -F "positionY=75" \
  -F "scale=0.25" \
  -F "anchor=bottom-left"
```

### 2. Upload Template

Upload a background video (e.g., Minecraft gameplay).

```bash
curl -X POST http://localhost:3000/api/templates \
  -F "video=@minecraft_gameplay.mp4" \
  -F "name=Minecraft Parkour" \
  -F "description=Satisfying gameplay footage"
```

### 3. Link Characters to Template

Define which characters are available in a specific template.

```bash
curl -X POST http://localhost:3000/api/templates/TEMPLATE_ID/characters \
  -H "Content-Type: application/json" \
  -d '{"characterIds": ["STEWIE_ID", "PETER_ID"]}'
```

### 4. 🚀 One-Command Generation

Generate a unique video by providing a plot. The AI will write the script, generate audio, and render the video.

```bash
curl -X POST http://localhost:3000/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "templateId": "TEMPLATE_ID",
    "plot": "Stewie is impressed by the Minecraft parkour skills, but Peter keeps making dumb comments about how the player should just use a ladder."
  }'
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "JOB_ID",
    "status": "generating_script",
    "message": "AI is generating the script..."
  }
}
```

### 5. Check Status

Poll the status of your generation job.

```bash
curl http://localhost:3000/api/generate/JOB_ID
```

**Response (Completed):**

```json
{
  "success": true,
  "data": {
    "id": "JOB_ID",
    "status": "completed",
    "progress": 100,
    "title": "Parkour Debate",
    "outputUrl": "https://bucket.s3.amazonaws.com/compositions/video_final.mp4",
    "subtitlesUrl": "https://bucket.s3.amazonaws.com/subtitles/subs.srt"
  }
}
```

### 6. Download Video

Get the direct S3 URL for the final video.

```bash
curl http://localhost:3000/api/generate/JOB_ID | jq -r '.data.outputUrl'
```
