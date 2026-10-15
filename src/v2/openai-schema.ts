// Deliberately a strict subset of the documented Structured Outputs subset.
// https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas
type Schema=Record<string,unknown>;
const object=(value:unknown):value is Schema=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fail=(code:string):never=>{throw new Error(`gm_schema_${code}`);};
const schema=(value:unknown):Schema=>object(value)?value:fail('invalid_node');
const numberBounds=['minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf'];
const arrayBounds=['minItems','maxItems'];
const formats=new Set(['date-time','time','date','duration','email','hostname','ipv4','ipv6','uuid']);
const supported=new Set(['type','properties','required','additionalProperties','$defs','$ref','anyOf','enum','const','items',
  ...numberBounds,...arrayBounds,'pattern','format','description']);

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
      // Length is still enforced by Zod; describe its Unicode semantics instead of
      // inventing a regex with different Unicode counting/trim behavior.
      if(key==='minLength'||key==='maxLength')continue;
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
    if('minLength' in node||'maxLength' in node) {
      if('description' in node&&typeof node.description!=='string')return fail('invalid_description');
      for(const key of ['minLength','maxLength'])if(key in node&&(!Number.isSafeInteger(node[key])||Number(node[key])<0))return fail('invalid_bound');
      if(node.type!=='string'||Number(node.minLength??0)>Number(node.maxLength??Infinity))return fail('invalid_bound');
      out.description=[node.description,`Length ${node.minLength??0}..${node.maxLength??'unbounded'}.`].filter(v=>v!==undefined).join(' ');
    }
    return out;
  }
  const result=convert(root);
  assertStructuredSchema(result);
  // Internal definition names are not domain data. Rename only schema keys/refs,
  // never enum values, descriptions or property names; leave more room for memory.
  if(object(result.$defs)) {
    const names=new Map(Object.keys(result.$defs).map((name,i)=>[name,`d${i}`]));
    function compact(node:Schema) {
      if(typeof node.$ref==='string')node.$ref=`#/$defs/${names.get(node.$ref.slice('#/$defs/'.length))}`;
      if(object(node.properties))Object.values(node.properties).forEach(n=>compact(schema(n)));
      if(object(node.$defs))Object.values(node.$defs).forEach(n=>compact(schema(n)));
      if(node.items)compact(schema(node.items));
      if(Array.isArray(node.anyOf))node.anyOf.forEach(n=>compact(schema(n)));
    }
    compact(result);
    result.$defs=Object.fromEntries(Object.entries(result.$defs).map(([name,node])=>[names.get(name)!,node]));
    // A single-use definition adds indirection, not compression. Inline it exactly.
    const definitions=schema(result.$defs),uses=new Map<string,number>();
    function children(node:Schema,visit:(node:Schema)=>void) {
      for(const key of ['properties','$defs'])if(object(node[key]))Object.values(node[key]).forEach(n=>visit(schema(n)));
      if(node.items)visit(schema(node.items));
      if(Array.isArray(node.anyOf))node.anyOf.forEach(n=>visit(schema(n)));
    }
    function count(node:Schema) {
      if(typeof node.$ref==='string')uses.set(node.$ref,(uses.get(node.$ref)??0)+1);
      children(node,count);
    }
    count(result);
    function inline(node:Schema) {
      while(typeof node.$ref==='string'&&uses.get(node.$ref)===1) {
        const target=structuredClone(definitions[node.$ref.slice('#/$defs/'.length)]);
        delete node.$ref;Object.assign(node,target);
      }
      children(node,inline);
    }
    inline(result);
    for(const name of Object.keys(definitions))if(uses.get(`#/$defs/${name}`)===1)delete definitions[name];
    assertStructuredSchema(result);
  }
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
    if('description' in node&&typeof node.description!=='string')return fail('invalid_description');
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
    for(const key of numberBounds)if(key in node) {
      if(!['number','integer'].includes(type)||typeof node[key]!=='number'||!Number.isFinite(node[key])||
        (key==='multipleOf'&&Number(node[key])<=0))return fail('invalid_bound');
    }
    for(const key of arrayBounds)if(key in node) {
      if(type!=='array'||!Number.isSafeInteger(node[key])||Number(node[key])<0)return fail('invalid_bound');
    }
    if(Number(node.minimum??-Infinity)>Number(node.maximum??Infinity)||
      Number(node.minItems??0)>Number(node.maxItems??Infinity))return fail('invalid_bound');
    if('pattern' in node) {
      if(type!=='string'||typeof node.pattern!=='string')return fail('invalid_pattern');
      try {new RegExp(node.pattern,'u');}catch {return fail('invalid_pattern');}
    }
    if('format' in node&&(type!=='string'||typeof node.format!=='string'||!formats.has(node.format)))return fail('invalid_format');
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
  return {profile:'liferpg-structured-outputs-v2',properties,enum_values:enums,string_characters:strings,max_depth:maxDepth};
}
