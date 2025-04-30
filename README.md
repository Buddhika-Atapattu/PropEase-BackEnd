<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>PropEase Backend - README</title>
  <style>
    body {
      font-family: system-ui, sans-serif;
      line-height: 1.6;
      padding: 2rem;
      background-color: #f9f9f9;
      color: #1a1a1a;
    }
    h1, h2, h3 {
      color: #08122f;
    }
    code, pre {
      background-color: #efefef;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-family: monospace;
    }
    pre {
      padding: 1rem;
      overflow-x: auto;
    }
    .section {
      margin-bottom: 2rem;
    }
  </style>
</head>
<body>
  <h1>🏗️ PropEase Backend Server</h1>
  <p>A backend server for <strong>PropEase</strong>, a scalable Node.js application written in TypeScript. Designed to support modern, modular, and efficient property management systems.</p>

  <div class="section">
    <h2>📦 Tech Stack</h2>
    <ul>
      <li>Node.js</li>
      <li>Express.js</li>
      <li>TypeScript</li>
      <li>Nodemon (for development)</li>
      <li>dotenv (for environment configuration)</li>
    </ul>
  </div>

  <div class="section">
    <h2>🚀 Getting Started</h2>
    <h3>1. Clone the Repository</h3>
    <pre><code>git clone https://github.com/your-username/PropEase-BackEnd.git
cd PropEase-BackEnd</code></pre>

    <h3>2. Install Dependencies</h3>
    <pre><code>npm install</code></pre>

    <h3>3. Development Mode</h3>
    <p>Run the server with live-reload using Nodemon:</p>
    <pre><code>npm run dev</code></pre>

    <h3>4. Build for Production</h3>
    <pre><code>npm run build</code></pre>

    <h3>5. Run Compiled Production Code</h3>
    <pre><code>npm start</code></pre>
  </div>

  <div class="section">
    <h2>⚙️ TypeScript Configuration</h2>
    <p>Core settings in <code>tsconfig.json</code>:</p>
    <pre><code>{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}</code></pre>
  </div>

  <div class="section">
    <h2>📁 Project Structure</h2>
    <pre><code>PropEase-BackEnd/
├── src/
│   ├── index.ts
│   ├── routes/
│   ├── controllers/
│   └── services/
├── public/
├── .env
├── tsconfig.json
├── package.json
└── README.md</code></pre>
  </div>

  <div class="section">
    <h2>📜 Scripts</h2>
    <pre><code>{
  "scripts": {
    "dev": "nodemon src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  }
}</code></pre>
  </div>

  <div class="section">
    <h2>🔐 Environment Variables</h2>
    <p>Create a <code>.env</code> file in the root directory:</p>
    <pre><code>PORT=3000
DB_URI=mongodb://localhost:27017/your-db</code></pre>
    <p>Make sure <code>.env</code> is listed in your <code>.gitignore</code>.</p>
  </div>

  <div class="section">
    <h2>🗂️ Public Folder</h2>
    <p>The <code>public/</code> folder is included to serve static HTML or assets. It is <strong>not</strong> excluded from Git.</p>
  </div>

  <div class="section">
    <h2>🤝 Contribution Guidelines</h2>
    <ul>
      <li>Follow clean code principles.</li>
      <li>Use TypeScript types and interfaces where appropriate.</li>
      <li>Stick to the project structure.</li>
      <li>Test your endpoints before pushing.</li>
    </ul>
  </div>

  <div class="section">
    <h2>📄 License</h2>
    <p>This project is licensed under the <strong>MIT License</strong>.</p>
  </div>
</body>
</html>
