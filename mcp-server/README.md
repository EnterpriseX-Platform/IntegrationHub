# Integration Flow MCP Server

MCP Server สำหรับจัดการ Flow บน Integration Platform

## Features

- 🔍 **Get Flow** - ดูรายละเอียด Flow
- ✏️ **Update Flow Nodes** - แก้ไข nodes และ connections
- ⚙️ **Update Schedule Parameters** - ตั้งค่า parameters สำหรับ schedule-trigger
- 🗄️ **Update Database SQL** - แก้ไข SQL query ใน database node
- ▶️ **Execute Flow** - รัน Flow พร้อม parameters
- 📊 **Get Executions** - ดูประวัติการรัน
- 📝 **Get Logs** - ดู logs ของการรันแต่ละครั้ง
- 🔎 **Find Node** - หา node ตาม type
- 📈 **Analyze Flow** - วิเคราะห์โครงสร้าง Flow

## Installation

```bash
cd mcp-server
npm install
npm run build
```

## Usage with Claude Desktop

เพิ่มใน `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "integration-flow": {
      "command": "node",
      "args": ["/path/to/mcp-server/dist/index.js"],
      "env": {
        "API_URL": "http://localhost:3001/api"
      }
    }
  }
}
```

## Example Usage

### 1. วิเคราะห์ Flow
```
 analyze_flow with flowId="<flowId>"
```

### 2. หา Schedule-trigger Node
```
 find_node_by_type with flowId="<flowId>", nodeType="schedule-trigger"
```

### 3. อัปเดต Parameters
```
 update_schedule_trigger_params with flowId="<flowId>", nodeId="node-xxx", parameters=[{name:"year", value:"{{year-1}}"}]
```

### 4. อัปเดต SQL
```
 update_database_sql with flowId="<flowId>", nodeId="node-yyy", sql="SELECT * FROM budget WHERE year={{vars.year}}"
```

### 5. รัน Flow
```
 execute_flow with flowId="<flowId>", parameters={"year": 2024}
```

## Environment Variables

- `API_URL` - Backend API URL (default: http://localhost:3001/api)

## Available Tools

| Tool | Description |
|------|-------------|
| `get_flow` | ดูรายละเอียด Flow |
| `update_flow_nodes` | แก้ไข nodes และ connections |
| `update_schedule_trigger_params` | อัปเดต parameters ของ schedule-trigger |
| `update_database_sql` | อัปเดต SQL ใน database node |
| `execute_flow` | รัน Flow |
| `get_flow_executions` | ดูประวัติการรัน |
| `get_execution_logs` | ดู logs |
| `list_project_flows` | ดูรายการ Flow ใน project |
| `find_node_by_type` | หา node ตาม type |
| `analyze_flow` | วิเคราะห์ Flow |
