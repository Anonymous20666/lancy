import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MANIFEST_PATH = path.join(__dirname, 'manifest.json');

/**
 * PlogmeRegistry — in-memory query engine and registry for the audited
 * plogme@2.0.7 Baileys API capabilities and symbols.
 */
export class PlogmeRegistry {
  constructor(manifestPath = MANIFEST_PATH) {
    this.manifestPath = manifestPath;
    this.manifest = null;
    this.#load();
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.manifestPath, 'utf8');
      this.manifest = JSON.parse(raw);
    } catch (err) {
      this.manifest = {
        metadata: { package: 'plogme', version: '2.0.7', totalExports: 0, featuresCount: 0 },
        categories: [],
        features: [],
        exports: []
      };
    }
  }

  getMetadata() {
    return this.manifest?.metadata || {};
  }

  getAllCategories() {
    return this.manifest?.categories || [];
  }

  getCategory(catId) {
    if (!catId) return null;
    const clean = String(catId).trim().toLowerCase();
    return this.getAllCategories().find(
      (c) => c.id.toLowerCase() === clean || c.prefix.toLowerCase() === clean
    ) || null;
  }

  getAllFeatures() {
    return this.manifest?.features || [];
  }

  getFeaturesByCategory(catId) {
    const cat = this.getCategory(catId);
    if (!cat) return [];
    return this.getAllFeatures().filter((f) => f.category === cat.id);
  }

  getFeature(refId) {
    if (!refId) return null;
    const clean = String(refId).trim().toUpperCase();
    return this.getAllFeatures().find(
      (f) => f.id.toUpperCase() === clean || f.name.toLowerCase() === clean.toLowerCase()
    ) || null;
  }

  search(query) {
    if (!query || !String(query).trim()) return [];
    const term = String(query).trim().toLowerCase();

    // 1. Direct Ref ID match
    const exactRef = this.getFeature(term);
    if (exactRef) return [exactRef];

    // 2. Direct Category match
    const catMatch = this.getCategory(term);
    if (catMatch) {
      return this.getFeaturesByCategory(catMatch.id);
    }

    // 3. Substring / Token search across features
    return this.getAllFeatures().filter((f) => {
      return (
        f.id.toLowerCase().includes(term) ||
        f.name.toLowerCase().includes(term) ||
        f.method.toLowerCase().includes(term) ||
        (f.description && f.description.toLowerCase().includes(term)) ||
        (f.paramTypes && f.paramTypes.toLowerCase().includes(term)) ||
        (f.workingCode && f.workingCode.toLowerCase().includes(term)) ||
        (f.category && f.category.toLowerCase().includes(term))
      );
    });
  }

  getAllExports() {
    return this.manifest?.exports || [];
  }

  getExport(name) {
    if (!name) return null;
    const clean = String(name).trim();
    return this.getAllExports().find((e) => e.name.toLowerCase() === clean.toLowerCase()) || null;
  }

  getAuditSummary() {
    const meta = this.getMetadata();
    const categories = this.getAllCategories();
    const features = this.getAllFeatures();
    const exportsList = this.getAllExports();

    return {
      package: meta.package || 'plogme',
      version: meta.version || '2.0.7',
      auditTimestamp: meta.auditTimestamp,
      totalExports: meta.totalExports || exportsList.length,
      totalSocketMethods: meta.totalSocketMethods || 669,
      categoriesCount: categories.length,
      featuresCount: features.length,
      verificationSummary: meta.verificationSummary || {},
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        prefix: c.prefix,
        featureCount: features.filter((f) => f.category === c.id).length
      }))
    };
  }
}

export const registry = new PlogmeRegistry();
