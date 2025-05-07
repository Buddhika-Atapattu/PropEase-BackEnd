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
    <pre><code>git clone https://github.com/your-username/PropEase-BackEnd.git</code></pre> <pre><code>cd PropEase-BackEnd</code></pre>
    <h3>2. Install Dependencie</h3>
    <pre><code>npm install</code></pre>
    <h3>3. Development Mode</h3>
    <h4>Run the server with live-reload using Nodemon:</h4>
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
    /* Visit https://aka.ms/tsconfig to read more about this file */

    /* Projects */

    /* Language and Environment */
    "target": "ES2020",

    /* Modules */
    "module": "commonjs",
    "rootDir": "./src", // ADDED: source files location
    "outDir": "./dist", // ADDED: compiled JS output

    /* JavaScript Support */

    /* Emit */

    /* Interop Constraints */
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,

    /* Type Checking */
    "strict": true,
    /* Completeness */
    "skipLibCheck": true

},
"include": ["src/app.ts"], // ADDED: watch only src/app.ts
"exclude": ["node_modules"] // ADDED: ignore node_modules
}
</code></pre>

  </div>

  <div class="section">
    <h2>📁 Project Structure</h2>
    <pre><code>PropEase-BackEnd/
├── public/
├── src/
│   ├── index.ts
│   ├── api/
│   ├── configs/
│   ├── models/
│   └── app.ts
├── .env
├── tsconfig.json
├── package.json
└── README.md</code></pre>
  </div>

  <div class="section">
    <h2>📜 Package.json</h2>
    <pre><code>
    {
  "name": "propease-backend",
  "version": "1.0.0",
  "description": "PropEase is a modern real estate management platform designed to simplify property listing, tenant coordination, agent management, and transaction handling for residential and commercial properties.",
  "main": "dist/app.js",
  "scripts": {
    "build": "tsc -p tsconfig.build.json && npm run copy-public",
    "copy-public": "cpx2 \"public/**/*\" dist/public",
    "start": "node dist/app.js",
    "dev": "nodemon src/app.ts"
  },
  "keywords": [
    "node",
    "express",
    "TypeScript"
  ],
  "author": "Buddhika",
  "license": "ISC",
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.5.0",
    "express": "^5.1.0",
    "glob": "^11.0.2",
    "mongoose": "^8.14.0"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^5.0.1",
    "@types/glob": "^8.1.0",
    "@types/mongoose": "^5.11.96",
    "cpx2": "^8.0.0",
    "nodemon": "^3.1.10",
    "ts-node": "^10.9.2",
    "typescript": "^5.8.3"
  }
}
    </code></pre>
  </div>

  <div class="section">
    <h2>📜 Scripts</h2>
    <pre><code>{
  "scripts": {
    "build": "tsc -p tsconfig.build.json && npm run copy-public",
    "copy-public": "cpx2 \"public/**/*\" dist/public",
    "start": "node dist/app.js",
    "dev": "nodemon src/app.ts"
  },
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
