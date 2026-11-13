// YAML Utility - Shared converter for OpenAPI YAML format

/**
 * Convert JavaScript object to YAML string
 * Format matches OpenAPI specification standard
 */
export const convertToYaml = (obj: any, indent: number = 0): string => {
  const spaces = '  '.repeat(indent);
  
  if (obj === null) return 'null';
  if (typeof obj === 'string') {
    // Check if string needs quoting
    // Numbers (including decimals like 1.0.0) should be quoted to ensure they're parsed as strings
    const looksLikeNumber = /^[\d.]+$/.test(obj) && obj !== '.';
    const needsQuote = obj === '' || looksLikeNumber || obj === 'true' || obj === 'false' || obj === 'null' ||
        obj.includes(':') || obj.includes('#') || obj.includes('{') || obj.includes('[') || 
        obj.includes('"') || obj.includes('\'') || obj.includes('\n') || obj.startsWith(' ') || obj.startsWith('-');
    if (needsQuote) {
      return `"${obj.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return obj;
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    const items = obj.map(item => {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        // Object in array: start with - and put first key on same line
        // Filter out both undefined and null values
        const entries = Object.entries(item).filter(([_, v]) => v !== undefined && v !== null);
        if (entries.length === 0) return `${spaces}- {}`;
        
        const lines: string[] = [];
        entries.forEach(([key, value], idx) => {
          const safeKey = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) ? key : `"${key}"`;
          if (idx === 0) {
            // First key goes on same line as -
            const valueYaml = convertToYaml(value, indent + 1);
            if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0) {
              lines.push(`${spaces}- ${safeKey}:`);
              // Add nested object properties with extra indent
              const nestedYaml = convertToYaml(value, indent + 2);
              lines.push(nestedYaml);
            } else {
              lines.push(`${spaces}- ${safeKey}: ${valueYaml}`);
            }
          } else {
            // Subsequent keys go on new lines with indent
            const valueYaml = convertToYaml(value, indent + 1);
            if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0) {
              lines.push(`${spaces}  ${safeKey}:`);
              lines.push(convertToYaml(value, indent + 2));
            } else if (Array.isArray(value)) {
              lines.push(`${spaces}  ${safeKey}:`);
              lines.push(convertToYaml(value, indent + 2));
            } else {
              lines.push(`${spaces}  ${safeKey}: ${valueYaml}`);
            }
          }
        });
        return lines.join('\n');
      } else if (Array.isArray(item)) {
        return `${spaces}- ${convertToYaml(item, indent + 1)}`;
      } else {
        return `${spaces}- ${convertToYaml(item, indent + 1)}`;
      }
    });
    const result = items.join('\n');
    // Add leading newline for top-level arrays to ensure proper YAML structure
    return indent === 0 ? '\n' + result : result;
  }
  
  if (typeof obj === 'object') {
    // Filter out both undefined and null values for cleaner YAML
    const entries = Object.entries(obj).filter(([_, v]) => v !== undefined && v !== null);
    if (entries.length === 0) return '{}';
    const result = entries.map(([key, value]) => {
      const safeKey = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) ? key : `"${key}"`;
      if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0) {
        return `${spaces}${safeKey}:\n${convertToYaml(value, indent + 1)}`;
      } else if (Array.isArray(value)) {
        return `${spaces}${safeKey}:\n${convertToYaml(value, indent + 1)}`;
      } else {
        return `${spaces}${safeKey}: ${convertToYaml(value, indent + 1)}`;
      }
    }).join('\n');
    // Add leading newline for top-level objects to ensure proper YAML structure
    return indent === 0 ? '\n' + result : result;
  }
  
  return String(obj);
};

/**
 * Check if a string is a valid unquoted YAML key
 */
const isValidYamlKey = (key: string): boolean => {
  // Valid YAML keys: start with letter/underscore, contain only alphanumeric, underscore, hyphen
  return /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key);
};

/**
 * Convert value to YAML for OpenAPI - handles special cases for OpenAPI spec
 */
const convertToOpenApiYaml = (obj: any, indent: number = 0, isKey: boolean = false): string => {
  const spaces = '  '.repeat(indent);
  
  if (obj === null) return 'null';
  if (typeof obj === 'string') {
    // For keys in OpenAPI, handle special cases
    if (isKey) {
      // Path keys (like /new-path) - quote if contains special chars like {param}
      if (/^\//.test(obj)) {
        if (/[{}]/.test(obj)) {
          return `"${obj}"`;
        }
        return obj;
      }
      // HTTP methods should NOT be quoted
      if (/^(get|post|put|delete|patch|head|options|trace)$/i.test(obj)) {
        return obj.toLowerCase();
      }
      // Response codes (200, 201, etc) should be quoted as strings
      if (/^\d{3}$/.test(obj)) {
        return `"${obj}"`;
      }
      // Standard keys - don't quote if valid
      if (isValidYamlKey(obj)) {
        return obj;
      }
      // Other keys need quoting
      return `"${obj.replace(/"/g, '\\"')}"`;
    }
    
    // For values - check if quoting is needed
    const looksLikeNumber = /^[\d.]+$/.test(obj) && obj !== '.';
    const needsQuote = obj === '' || looksLikeNumber || obj === 'true' || obj === 'false' || obj === 'null' ||
        obj.includes(':') || obj.includes('#') || obj.includes('{') || obj.includes('[') || 
        obj.includes('"') || obj.includes('\'') || obj.includes('\n') || obj.startsWith(' ') || obj.startsWith('-');
    if (needsQuote) {
      return `"${obj.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return obj;
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    const items = obj.map(item => {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        // Filter out undefined, null, and empty strings
        const entries = Object.entries(item).filter(([_, v]) => {
          if (v === undefined || v === null) return false;
          if (typeof v === 'string' && v === '') return false;
          return true;
        });
        if (entries.length === 0) return `${spaces}- {}`;
        
        const lines: string[] = [];
        entries.forEach(([key, value], idx) => {
          const safeKey = convertToOpenApiYaml(key, 0, true);
          if (idx === 0) {
            const valueYaml = convertToOpenApiYaml(value, indent + 1);
            if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0) {
              lines.push(`${spaces}- ${safeKey}:`);
              lines.push(convertToOpenApiYaml(value, indent + 2));
            } else {
              lines.push(`${spaces}- ${safeKey}: ${valueYaml}`);
            }
          } else {
            const valueYaml = convertToOpenApiYaml(value, indent + 1);
            if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0) {
              lines.push(`${spaces}  ${safeKey}:`);
              lines.push(convertToOpenApiYaml(value, indent + 2));
            } else if (Array.isArray(value)) {
              lines.push(`${spaces}  ${safeKey}:`);
              lines.push(convertToOpenApiYaml(value, indent + 2));
            } else {
              lines.push(`${spaces}  ${safeKey}: ${valueYaml}`);
            }
          }
        });
        return lines.join('\n');
      } else if (Array.isArray(item)) {
        return `${spaces}- ${convertToOpenApiYaml(item, indent + 1)}`;
      } else {
        return `${spaces}- ${convertToOpenApiYaml(item, indent + 1)}`;
      }
    });
    return items.join('\n');
  }
  
  if (typeof obj === 'object') {
    // Filter out undefined, null, and empty strings for cleaner YAML
    const entries = Object.entries(obj).filter(([_, v]) => {
      if (v === undefined || v === null) return false;
      if (typeof v === 'string' && v === '') return false;
      return true;
    });
    if (entries.length === 0) return '{}';
    const result = entries.map(([key, value]) => {
      const safeKey = convertToOpenApiYaml(key, 0, true);
      if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0) {
        return `${spaces}${safeKey}:\n${convertToOpenApiYaml(value, indent + 1)}`;
      } else if (Array.isArray(value)) {
        if (value.length === 0) {
          return `${spaces}${safeKey}: []`;
        }
        return `${spaces}${safeKey}:\n${convertToOpenApiYaml(value, indent + 1)}`;
      } else {
        return `${spaces}${safeKey}: ${convertToOpenApiYaml(value, indent + 1)}`;
      }
    }).join('\n');
    return result;
  }
  
  return String(obj);
};

/**
 * Convert internal OpenAPI spec format to standard OpenAPI YAML
 */
export const specToOpenApiYaml = (spec: {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: { url: string; description?: string }[];
  operations?: any[];
  requireApiKey?: boolean;
  generatedPublicUrl?: string;
}): string => {
  // Convert operations to paths (OpenAPI standard)
  const paths: any = {};
  spec.operations?.forEach((op: any) => {
    if (!paths[op.path]) paths[op.path] = {};
    
    // Convert responses array to object
    const responses: any = {};
    if (op.responses && Array.isArray(op.responses)) {
      op.responses.forEach((resp: any) => {
        responses[resp.code] = {
          description: resp.description && resp.description.trim() !== '' ? resp.description : 'OK',
          ...(resp.content ? { content: resp.content } : {})
        };
      });
    } else {
      responses['200'] = { description: 'Success' };
    }
    
    // Build operation object - fields in OpenAPI standard order
    const operation: any = {
      operationId: op.id,
      summary: op.summary,
    };

    // Only add optional fields if they exist and are not empty
    if (op.description && op.description.trim() !== '') {
      operation.description = op.description;
    }
    if (op.parameters && op.parameters.length > 0) {
      operation.parameters = op.parameters;
    }
    if (op.requestBody) {
      operation.requestBody = op.requestBody;
    }
    // responses must come after parameters/requestBody
    operation.responses = responses;
    
    paths[op.path][op.method.toLowerCase()] = operation;
  });

  // Build OpenAPI spec
  const fullSpec: any = {
    openapi: spec.openapi || '3.0.3',
    info: {
      title: spec.info?.title || 'API',
      version: spec.info?.version || '1.0.0',
    },
    servers: spec.servers || [{ url: spec.generatedPublicUrl || '/api/v1' }],
    paths: paths,
  };
  
  // Only add description if it exists
  if (spec.info?.description) {
    fullSpec.info.description = spec.info.description;
  }
  
  // Add global security and components if API key required
  if (spec.requireApiKey) {
    fullSpec.security = [{ ApiKeyAuth: [] }];
    fullSpec.components = {
      securitySchemes: {
        ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
    };
  }

  // Generate YAML using OpenAPI-specific converter
  // Note: indent starts at 1 for nested content under each section
  const yamlContent = `openapi: ${fullSpec.openapi}
info:
${convertToOpenApiYaml(fullSpec.info, 1)}
servers:
${convertToOpenApiYaml(fullSpec.servers, 1)}
paths:
${convertToOpenApiYaml(fullSpec.paths, 1)}${fullSpec.security ? `
security:
${convertToOpenApiYaml(fullSpec.security, 1)}` : ''}${fullSpec.components ? `
components:
${convertToOpenApiYaml(fullSpec.components, 1)}` : ''}`;

  return yamlContent;
};

export default { convertToYaml, specToOpenApiYaml };
