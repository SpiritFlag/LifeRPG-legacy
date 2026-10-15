// Deliberately a strict subset of the documented Structured Outputs subset.
// https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas
type Schema=Record<string,unknown>;
const object=(value:unknown):value is Schema=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fail=(code:string):never=>{throw new Error(`gm_schema_${code}`);};
const schema=(value:unknown):Schema=>object(value)?value:fail('invalid_node');
const supported=new Set(['type','properties','required','additionalProperties','$defs','$ref','anyOf','enum','const','items']);
// These bounds were already enforced only by local Zod, not sent in the compact wire schema.
const localBounds=new Set(['minLength','maxLength','minimum','maximum','minItems','maxItems','pattern','format']);

function resolveRef(node:Schema,root:Schema,seen=new Set<string>()):Schema {
  if(!('$ref' in node))return node;
  const ref=node.$ref;
  if(typeof ref!=='string'||!/^#\/\$defs\/[A-Za-z0-9_-]+$/.test(ref)||seen.has(ref))return fail('invalid_ref');
  seen.add(ref);
  const defs=schema(root.$defs),name=ref.slice('#/$defs/'.length);
  if(!Object.hasOwn(defs,name))return fail('invalid_ref');
  return resolveRef(schema(defs[name]),root,seen);
}

/** oneOf == anyOf only if a required literal discriminator makes branches disjoint. */
function proveDisjoint(branches:unknown,root:Schema):unknown[] {
  if(!Array.isArray(branches)||branches.length<2)return fail('ambiguous_union');
  const nodes=branches.map(v=>resolveRef(schema(v),root));
  if(nodes.some(n=>n.type!=='object'||!object(n.properties)||!Array.isArray(n.required)))return fail('ambiguous_union');
  const candidates=(nodes[0].required as unknown[]).filter((v):v is string=>typeof v==='string');
  for(const key of candidates) {
    const seen=new Set<string>();let disjoint=true;
    for(const node of nodes) {
      if(!(node.required as unknown[]).includes(key)||!Object.hasOwn(schema(node.properties),key)){disjoint=false;break;}
      const tag=resolveRef(schema(schema(node.properties)[key]),root);
      const values='const' in tag?[tag.const]:tag.enum;
      if(tag.type!=='string'||!Array.isArray(values)||!values.length||values.some(v=>typeof v!=='string')){disjoint=false;break;}
      const unique=new Set(values as string[]);
      if([...unique].some(v=>seen.has(v))){disjoint=false;break;}
      for(const value of unique)seen.add(value);
    }
    if(disjoint)return branches;
  }
  return fail('ambiguous_union');
}

export function compileStructuredSchema(value:unknown):Schema {
  const root=schema(value);
  function convert(value:unknown):Schema {
    const node=schema(value),out:Schema={};
    for(const [key,v] of Object.entries(node)) {
      if(localBounds.has(key))continue;
      if(key==='oneOf') {
        if('anyOf' in node)return fail('ambiguous_union');
        out.anyOf=proveDisjoint(v,root).map(convert);
      } else if(key==='properties'||key==='$defs') {
        out[key]=Object.fromEntries(Object.entries(schema(v)).map(([name,child])=>[name,convert(child)]));
      } else if(key==='items')out[key]=convert(v);
      else if(key==='anyOf') {
        if(!Array.isArray(v))return fail('invalid_union');
        out[key]=v.map(convert);
      } else out[key]=structuredClone(v);
    }
    return out;
  }
  const result=convert(root);
  assertStructuredSchema(result);
  function freeze(value:unknown) {
    if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}
  }
  freeze(result);
  return result;
}

/** Fail closed on unknown keywords, open objects, bad refs and documented size ceilings.
 * This application's profile excludes recursive refs and additional optional schema features;
 * passing it is a local compatibility check, not a promise of provider acceptance. */
export function assertStructuredSchema(value:unknown) {
  const root=schema(value);
  if(root.type!=='object'||'anyOf' in root||'$ref' in root)return fail('root_object_required');
  let properties=0,enums=0,strings=0;
  function visit(value:unknown) {
    const node=schema(value),keys=Object.keys(node);
    if(keys.some(key=>!supported.has(key)))return fail('unsupported_keyword');
    if('$defs' in node) {
      for(const [name,child] of Object.entries(schema(node.$defs))) {
        if(!/^[A-Za-z0-9_-]+$/.test(name))return fail('invalid_definition');
        strings+=name.length;visit(child);
      }
    }
    if('$ref' in node) {
      if(keys.length!==1)return fail('ref_siblings');
      resolveRef(node,root);return;
    }
    if('anyOf' in node) {
      if(keys.some(k=>k!=='anyOf'&&k!=='$defs')||!Array.isArray(node.anyOf)||node.anyOf.length<2)return fail('invalid_union');
      node.anyOf.forEach(visit);return;
    }
    const type=node.type;
    if(typeof type!=='string'||!['object','array','string','integer','number','boolean','null'].includes(type))return fail('invalid_type');
    if(type==='object') {
      const props=schema(node.properties),names=Object.keys(props),required=node.required;
      if(node.additionalProperties!==false||!Array.isArray(required)||required.length!==names.length||
        new Set(required).size!==required.length||names.some(n=>!required.includes(n)))return fail('closed_required_object');
      properties+=names.length;strings+=names.reduce((sum,n)=>sum+n.length,0);
      Object.values(props).forEach(visit);
    } else if(['properties','required','additionalProperties'].some(k=>k in node))return fail('invalid_type_keyword');
    if(type==='array')visit(node.items);
    else if('items' in node)return fail('invalid_type_keyword');
    if('enum' in node||'const' in node) {
      if(('enum' in node&&'const' in node)||['array','object'].includes(type))return fail('invalid_enum');
      const values='const' in node?[node.const]:node.enum;
      if(!Array.isArray(values)||!values.length||new Set(values).size!==values.length)return fail('invalid_enum');
      const matches=(v:unknown)=>type==='null'?v===null:type==='integer'?Number.isInteger(v):typeof v===type&&(typeof v!=='number'||Number.isFinite(v));
      if(!values.every(matches))return fail('invalid_enum');
      const length=values.reduce((sum,v)=>sum+(typeof v==='string'?v.length:0),0);
      strings+=length;
      if('enum' in node){enums+=values.length;if(values.length>250&&length>15000)return fail('enum_string_limit');}
    }
  }
  visit(root);
  if(properties>5000||enums>1000||strings>120000)return fail('size_limit');
  let maxDepth=0;
  function depth(value:unknown,level:number,refs:Set<string>):void {
    const node=schema(value);
    if('$ref' in node) {
      const ref=node.$ref as string;
      if(refs.has(ref))return fail('recursive_ref_outside_profile');
      depth(resolveRef(node,root),level,new Set([...refs,ref]));return;
    }
    const next=level+(node.type==='object'||node.type==='array'?1:0);
    maxDepth=Math.max(maxDepth,next);
    if(next>10)return fail('depth_limit');
    if(object(node.properties))Object.values(node.properties).forEach(n=>depth(n,next,refs));
    if('items' in node)depth(node.items,next,refs);
    if(Array.isArray(node.anyOf))node.anyOf.forEach(n=>depth(n,next,refs));
  }
  depth(root,0,new Set());
  // Unused definitions must also pass, rather than hiding unsupported subgraphs.
  if(object(root.$defs))Object.values(root.$defs).forEach(n=>depth(n,0,new Set()));
  return {profile:'liferpg-structured-outputs-v1',properties,enum_values:enums,string_characters:strings,max_depth:maxDepth};
}
