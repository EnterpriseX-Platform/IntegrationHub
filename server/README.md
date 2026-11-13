# Integration Platform API Server

Backend API server for the Integration Platform built with Express.js and TypeScript.

## Features

- 🔥 **Express.js** - Fast, unopinionated web framework
- 📘 **TypeScript** - Type-safe JavaScript
- 🔗 **CORS** - Cross-Origin Resource Sharing enabled
- 📊 **Mock Data** - Complete mock data for all 10 projects
- 🚀 **RESTful API** - Standard REST API design

## Project Structure

```
server/
├── src/
│   ├── data/
│   │   └── store.ts         # Mock data store
│   ├── routes/
│   │   ├── projects.ts      # Project routes
│   │   ├── flows.ts         # Flow routes
│   │   ├── executions.ts    # Execution routes
│   │   └── connections.ts   # Connection routes
│   ├── types/
│   │   └── index.ts         # TypeScript type definitions
│   └── index.ts             # Main entry point
├── package.json
├── tsconfig.json
└── .env.example
```

## Installation

```bash
# Navigate to server directory
cd server

# Install dependencies
npm install

# Copy environment file
cp .env.example .env
```

## Development

```bash
# Run in development mode (with hot reload)
npm run dev
```

## Production Build

```bash
# Build TypeScript
npm run build

# Start production server
npm start
```

## API Endpoints

### Projects

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects` | List all projects |
| GET | `/api/projects/:id` | Get project details with flows, connections, scheduler, apiSpecs |
| POST | `/api/projects/:id/flows` | Create new flow |

### Flows

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/flows/:id` | Get flow details |
| PUT | `/api/flows/:id` | Update flow (nodes, connections) |
| POST | `/api/flows/:id/execute` | Run flow execution |

### Executions

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/executions` | List all executions |
| GET | `/api/executions/:id/logs` | Get execution logs |

### Connections

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/connections/:id/test` | Test connection |


## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3001 |
| `NODE_ENV` | Environment mode | development |
| `CORS_ORIGIN` | CORS allowed origin | http://localhost:3000 |
| `API_PREFIX` | API route prefix | /api |

## Example Requests

```bash
# List all projects
curl http://localhost:3001/api/projects

# Get project details
curl http://localhost:3001/api/projects/proj-1

# Create new flow
curl -X POST http://localhost:3001/api/projects/proj-1/flows \
  -H "Content-Type: application/json" \
  -d '{"name":"New Flow","type":"trigger","nodes":[],"connections":[]}'

# Get flow details
curl http://localhost:3001/api/flows/flow-1-1

# Update flow
curl -X PUT http://localhost:3001/api/flows/flow-1-1 \
  -H "Content-Type: application/json" \
  -d '{"name":"Updated Flow","status":"Active"}'

# Execute flow
curl -X POST http://localhost:3001/api/flows/flow-1-1/execute

# List executions
curl http://localhost:3001/api/executions

# Get execution logs
curl http://localhost:3001/api/executions/exec-001/logs

# Test connection
curl http://localhost:3001/api/connections/conn-1-1/test
```
