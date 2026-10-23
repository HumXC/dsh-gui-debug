/** JSON-only design vocabulary; no validator or runtime behavior is implemented here. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export interface JsonSchema {
  readonly $schema?: string;
  readonly $id?: string;
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JsonSchema>>;
  readonly title?: string;
  readonly description?: string;
  readonly type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly propertyNames?: JsonSchema;
  readonly items?: JsonSchema;
  readonly oneOf?: readonly JsonSchema[];
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly default?: JsonValue;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly pattern?: string;
}

/** Only these three fields are projected to DSH's model-facing ToolSchema. */
export interface ToolDeclaration<Input, Output> {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  /** Type-only association; a future adapter adds execute/output rendering. */
  readonly contract?: { readonly input: Input; readonly output: Output };
}
