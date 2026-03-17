# copper-mcp

MCP server for the [Copper CRM](https://www.copper.com/) API. Search contacts, log activities, manage opportunities, and query companies.

## Tools

| Tool | Description |
|------|-------------|
| `search_people` | Search contacts by name, email, or phone |
| `get_person` | Get full contact details by ID |
| `create_person` | Create a new contact |
| `update_person` | Update contact fields |
| `search_companies` | Search companies by name |
| `list_activity_types` | List available activity types |
| `create_activity` | Log a meeting, call, or note against a contact/company |
| `list_activities` | Search activities with filters and resolved parent names |
| `list_opportunities` | Search deals/opportunities |

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your credentials:
   ```bash
   cp .env.example .env
   ```

   Required environment variables:
   - `COPPER_API_KEY` - Your Copper API key
   - `COPPER_USER_EMAIL` - Your Copper account email
   - `COPPER_USER_ID` - Your Copper user ID

## Usage with Claude Code

Add to your Claude Code MCP config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "copper-crm": {
      "command": "node",
      "args": ["/path/to/copper-mcp/server.js"],
      "env": {
        "COPPER_API_KEY": "your-api-key",
        "COPPER_USER_EMAIL": "your-email",
        "COPPER_USER_ID": "your-user-id"
      }
    }
  }
}
```

## License

MIT
