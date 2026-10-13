import { registry } from './registry.js';

/**
 * PlogmeRenderer — formats single-message rich responses with native copy buttons,
 * compact category indices, deep-dive specifications, and test lab diagnostics.
 */
export class PlogmeRenderer {
  /**
   * Build the master explorer index message payload.
   * Returns { text, footer, nativeFlow, buttonsFallback } ready for session.sendInteractiveMessage.
   */
  static renderMasterMenu({ p = '.' } = {}) {
    const summary = registry.getAuditSummary();
    const categories = registry.getAllCategories();

    const catLines = categories.map((c, i) => {
      return `${i + 1}. ${c.icon} *${c.name}* (${c.prefix})\n   ↳ \`${p}tmenu ${c.id}\``;
    }).join('\n');

    const text = `╭────────────────────────────────╮
│  ✦ PLOGME BAILEYS EXPLORER ✦   │
╰────────────────────────────────╯

📦 *Package Audit:* \`plogme@${summary.version}\`
📊 *Discovered Scope:* ${summary.totalExports} Exports • ${summary.totalSocketMethods} Socket Methods
✨ *Audited Catalog:* ${summary.featuresCount} Features (${summary.verificationSummary['VERIFIED-LOCAL'] || 0} Verified-Local • ${summary.verificationSummary['VERIFIED-STATIC'] || 0} Verified-Static)

📁 *Categories Index:*
${catLines}

💡 *Interactive Commands:*
• *${p}tmenu <category>* — Browse category (e.g. *${p}tmenu rich*)
• *${p}tmenu <id>* — Inspect feature spec (e.g. *${p}tmenu PLOG-RCH-001*)
• *${p}tmenu search <query>* — Find API (e.g. *${p}tmenu search poll*)
• *${p}tmenu test <id>* — Execute Test Lab (e.g. *${p}tmenu test PLOG-RCH-001*)
• *${p}tmenu audit* — Full coverage & symbol breakdown ♡`;

    const footer = 'Plogme 2.0.7 • Tap native buttons below to copy code directly';

    // Real Native Copy Buttons (cta_copy)
    const nativeFlow = [
      { text: '📋 Copy Ref ID', copy: 'PLOG-RCH-001' },
      { text: '📋 Copy Signature', copy: 'sock.sendMessage(jid, { text: string, nativeFlow: Array<{ text, copy }> })' },
      { text: '📋 Copy Example Code', copy: 'await sock.sendMessage(jid, { text: "Hello", nativeFlow: [{ text: "📋 Copy", copy: "CODE_123" }] });' },
      { text: '📋 Copy AI Prompt', copy: 'Implement WhatsApp native copy buttons using plogme 2.0.7 sock.sendMessage(jid, { text, nativeFlow: [{ text, copy }] }).' }
    ];

    return { text, footer, nativeFlow };
  }

  /**
   * Render a specific category with its member features and copy buttons.
   */
  static renderCategoryView(catId, { p = '.' } = {}) {
    const category = registry.getCategory(catId);
    if (!category) return null;

    const features = registry.getFeaturesByCategory(category.id);
    const featureLines = features.map((f, i) => {
      const statusBadge = f.verificationStatus === 'VERIFIED-LOCAL' ? '🟢 Local' : (f.verificationStatus === 'VERIFIED-LIVE' ? '🟢 Live' : '🔵 Static');
      return `${i + 1}. \`[${f.id}]\` *${f.name}*\n   ↳ \`${f.method}\` [${statusBadge}]\n   ↳ Details: *${p}tmenu ${f.id}* | Test: *${p}tmenu test ${f.id}*`;
    }).join('\n\n');

    const text = `╭────────────────────────────────╮
│  ${category.icon} ${category.name.toUpperCase()}
╰────────────────────────────────╯
> 🏷️ Prefix: \`${category.prefix}\` • ${features.length} Features Documented
> ℹ️ ${category.description}

📋 *Features in this Category:*
${featureLines}

💡 *Commands:*
• *${p}tmenu <id>* — Full API spec & examples
• *${p}tmenu test <id>* — Run Test Lab verification
• *${p}tmenu* — Return to Master Explorer Menu ♡`;

    const footer = `Plogme 2.0.7 • Category: ${category.name}`;

    // Provide copy buttons for the primary feature in this category
    const topFeature = features[0];
    const nativeFlow = topFeature?.copyActions?.map((ca) => ({
      text: ca.label,
      copy: ca.text
    })) || [
      { text: '📋 Copy Category', copy: category.id },
      { text: '📋 Copy Prefix', copy: category.prefix }
    ];

    return { text, footer, nativeFlow };
  }

  /**
   * Render exhaustive specification for a single feature ID.
   */
  static renderFeatureView(feature, { p = '.' } = {}) {
    if (!feature) return null;

    const statusBadge = feature.verificationStatus.includes('LOCAL') || feature.verificationStatus.includes('LIVE')
      ? '🟢 ' + feature.verificationStatus
      : '🔵 ' + feature.verificationStatus;

    const text = `╭────────────────────────────────╮
│  ✦ [${feature.id}] ${feature.name.toUpperCase()} ✦
╰────────────────────────────────╯
> ✨ Category: *${feature.category}*
> 🛡️ Status: *${statusBadge}*
> 📦 Version: \`${feature.version}\`
> 📁 Source: \`${feature.sourceRef}\`

📝 *Method Signature:*
\`\`\`ts
${feature.signature}
\`\`\`

📥 *Parameters & Return Type:*
• Parameters: \`${feature.paramTypes}\`
• Return: \`${feature.returnType}\`

💻 *Minimal Working Code:*
\`\`\`js
${feature.workingCode}
\`\`\`

⚙️ *Prerequisites & Permissions:*
• Prerequisites: ${feature.prerequisites}
• Permissions: ${feature.permissions}
• Imports: \`${feature.imports}\`

⚠️ *Error Conditions & Cleanup:*
• Errors: ${feature.errorConditions}
• Cleanup: ${feature.listenerCleanup}

💡 *Actions:*
• Run test: *${p}tmenu test ${feature.id}*
• Back to menu: *${p}tmenu* ♡`;

    const footer = `Plogme 2.0.7 • [${feature.id}] Tap buttons to copy code`;

    const nativeFlow = feature.copyActions?.map((ca) => ({
      text: ca.label,
      copy: ca.text
    })) || [
      { text: '📋 Copy Ref ID', copy: feature.id },
      { text: '📋 Copy Signature', copy: feature.signature },
      { text: '📋 Copy Working Code', copy: feature.workingCode }
    ];

    return { text, footer, nativeFlow };
  }

  /**
   * Render search results for a query.
   */
  static renderSearchView(query, results, { p = '.' } = {}) {
    if (results.length === 0) {
      const text = `╭────────────────────────────────╮
│  🔍 SEARCH: "${query}"
╰────────────────────────────────╯
✕ No matching API features found for "${query}".

💡 *Tips:*
• Try broad terms like *poll*, *media*, *copy*, *group*, *channel*, or *react*
• Or browse categories directly with *${p}tmenu* ♡`;
      return { text, footer: 'Plogme Explorer • Search', nativeFlow: [{ text: '📋 Back to Menu', copy: `${p}tmenu` }] };
    }

    const resultLines = results.slice(0, 8).map((f, i) => {
      return `${i + 1}. \`[${f.id}]\` *${f.name}*\n   ↳ \`${f.method}\`\n   ↳ Details: *${p}tmenu ${f.id}*`;
    }).join('\n\n');

    const text = `╭────────────────────────────────╮
│  🔍 SEARCH: "${query}" (${results.length} found)
╰────────────────────────────────╯

${resultLines}

💡 Send *${p}tmenu <id>* to view full signature and code! ♡`;

    const footer = `Plogme Explorer • ${results.length} results for "${query}"`;
    const top = results[0];
    const nativeFlow = [
      { text: `📋 Copy Top Ref ID`, copy: top.id },
      { text: `📋 Copy Top Method`, copy: top.method },
      { text: `📋 Copy Top Code`, copy: top.workingCode }
    ];

    return { text, footer, nativeFlow };
  }

  /**
   * Render Test Lab execution outcome.
   */
  static renderTestResult(outcome, { p = '.' } = {}) {
    const isPass = outcome.status === 'PASS';
    const icon = isPass ? '✅' : '❌';

    const text = `╭────────────────────────────────╮
│  🧪 TEST LAB: [${outcome.refId}] ${icon}
╰────────────────────────────────╯
> ✨ Feature: *${outcome.name}*
> ⏱️ Duration: *${outcome.durationMs}ms*
> 🏷️ Mode: *${outcome.testType}* (${outcome.environment.version})
> 📅 Executed: \`${outcome.timestamp}\`

📋 *Result Details:*
${outcome.details}
${outcome.error ? `\n⚠️ *Error:* \`${outcome.error}\`` : ''}

💡 *Commands:*
• View Spec: *${p}tmenu ${outcome.refId}*
• Run Again: *${p}tmenu test ${outcome.refId}*
• Back to Menu: *${p}tmenu* ♡`;

    const footer = `Plogme Test Lab • ${outcome.status} in ${outcome.durationMs}ms`;
    const nativeFlow = [
      { text: '📋 Copy Test Ref ID', copy: outcome.refId },
      { text: '📋 Copy Test Command', copy: `${p}tmenu test ${outcome.refId}` }
    ];

    return { text, footer, nativeFlow };
  }

  /**
   * Render overall Audit and Symbol coverage diagnostics.
   */
  static renderAuditView({ p = '.' } = {}) {
    const summary = registry.getAuditSummary();
    const catStats = summary.categories.map((c) => `• ${c.name}: ${c.featureCount} features`).join('\n');

    const text = `╭────────────────────────────────╮
│  📊 PLOGME 2.0.7 AUDIT REPORT  │
╰────────────────────────────────╯
📦 *Package:* \`plogme@${summary.version}\`
📅 *Audit Timestamp:* \`${summary.auditTimestamp}\`

📈 *Symbol Counts:*
• Top-level Exports: *${summary.totalExports}*
• Socket Prototype Methods: *${summary.totalSocketMethods}*
• Catalogued Feature Specs: *${summary.featuresCount}*

🛡️ *Verification Breakdown:*
• Verified Local: *${summary.verificationSummary['VERIFIED-LOCAL'] || 0}*
• Verified Static: *${summary.verificationSummary['VERIFIED-STATIC'] || 0}*
• Partial / Gaps: *${summary.verificationSummary['PARTIAL'] || 0}*

📁 *Coverage by Category:*
${catStats}

💡 Send *${p}tmenu* to explore the interactive catalogue! ♡`;

    const footer = `Plogme 2.0.7 • Full Audit Summary`;
    const nativeFlow = [
      { text: '📋 Copy Audit Version', copy: `plogme@${summary.version}` },
      { text: '📋 Copy Total Exports', copy: `${summary.totalExports} exports` },
      { text: '📋 Copy Menu Command', copy: `${p}tmenu` }
    ];

    return { text, footer, nativeFlow };
  }
}
