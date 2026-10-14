// Target core: plain 3MF Core with the Materials extension (plan-deltas
// R50). One colorgroup holds one colour per filament and every triangle
// points at its slot's entry; no Metadata/*.config entries, no production
// extension, no slicer dialect.

import type { Attribution } from "../metadata.js";
import { esc, isoDay } from "./fmt.js";
import { instanceTransform, meshXml, type Planned, type WriterFilament } from "./model.js";

const COLORGROUP_ID = 1;

export function coreModelXml(title: string, epoch: number, P: readonly Planned[], filaments: readonly WriterFilament[], attr: Attribution): string {
  const day = isoDay(epoch);
  // Object ids sit above the colorgroup id; resource ids share one space.
  const shift = COLORGROUP_ID;
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
      'xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">\n',
  ];
  // LicenseTerms is the 3MF Core well-known name for the licence (LICENSING.md 1.4); written only when the chase has one.
  const meta: readonly (readonly [string, string])[] = [
    ["Copyright", attr.copyright], ["CreationDate", day], ["Designer", attr.designer],
    ...(attr.license === "" ? [] : [["LicenseTerms", attr.license] as const]), ["ModificationDate", day], ["Title", title],
  ];
  for (const [k, v] of meta) out.push(` <metadata name="${k}">${esc(v)}</metadata>\n`);
  out.push(` <resources>\n  <m:colorgroup id="${COLORGROUP_ID}">\n`);
  for (const f of filaments) out.push(`   <m:color color="${esc(f.color.toUpperCase())}FF"/>\n`);
  out.push("  </m:colorgroup>\n");
  for (const p of P) {
    p.obj.parts.forEach((part, i) => {
      const pindex = part.slot - 1;
      out.push(`  <object id="${p.meshIds[i]! + shift}" type="model" name="${esc(part.name)}" pid="${COLORGROUP_ID}" pindex="${pindex}">\n`,
        meshXml(part, () => ` pid="${COLORGROUP_ID}" p1="${pindex}"`), "  </object>\n");
    });
    out.push(`  <object id="${p.objId + shift}" type="model" name="${esc(p.obj.name)}">\n   <components>\n`);
    for (const mid of p.meshIds) out.push(`    <component objectid="${mid + shift}"/>\n`);
    out.push("   </components>\n  </object>\n");
  }
  out.push(" </resources>\n <build>\n");
  for (const p of P) {
    for (const inst of p.pos) {
      out.push(`  <item objectid="${p.objId + shift}" transform="${instanceTransform(inst)}"/>\n`);
    }
  }
  out.push(" </build>\n</model>\n");
  return out.join("");
}

export const CORE_CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
  ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
  ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
  ' <Default Extension="json" ContentType="application/json"/>\n</Types>\n';
