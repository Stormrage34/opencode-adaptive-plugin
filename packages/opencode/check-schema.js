import { Schema } from "effect";
import { Parameters } from "./src/tool/shell/prompt.js";
import { fromSchema } from "./src/tool/json-schema.js";

const schema = fromSchema(Parameters);
console.log(JSON.stringify(schema, null, 2));
