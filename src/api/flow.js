// api/flows.js — Vercel serverless function
// Serves flow JSON files with CORS headers

const fs = require('fs')
const path = require('path')

module.exports = (req, res) => {
  // Allow VS Code extension to fetch
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'public, max-age=3600')

  const { file } = req.query
  if (!file || !file.match(/^[a-z0-9-]+\.json$/)) {
    return res.status(400).json({ error: 'Invalid file name' })
  }

  const filePath = path.join(process.cwd(), 'flows', file)
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Flow not found' })
  }

  const content = fs.readFileSync(filePath, 'utf8')
  res.setHeader('Content-Type', 'application/json')
  res.send(content)
}