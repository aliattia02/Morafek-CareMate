/**
 * Consent Document Viewer
 * Location: mobile/app/(app)/ehr/consent-template.tsx
 *
 * Read-only view of the live, gICS-authored consent document (title,
 * header, each module's text, footer) — sourced from
 * GET /api/consent/template so the displayed text always matches whatever
 * is currently configured in gICS's admin UI, instead of being hardcoded
 * in the app.
 *
 * Purely additive: this screen performs no consent action itself.
 * Accept/revoke stay on the main consent screen (ehr/consent.tsx), which
 * keeps calling POST /api/consent/accept and /api/consent/revoke directly,
 * completely unaffected by whether this screen loads successfully.
 */

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getConsentTemplate, type ConsentTemplate } from '@/services/api/consent';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

// ─── minimal HTML → text-block parser ──────────────────────────────────────────
// No WebView / HTML-rendering dependency — this content is authored in
// gICS's admin UI as headings + paragraphs + inline bold, which is all
// this needs to handle. Anything else is flattened to plain paragraph
// text rather than crashing or being dropped.

interface HtmlBlock {
  heading: boolean;
  level?: number;
  text: string;
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_m, name: string) => HTML_ENTITIES[name] ?? `&${name};`)
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCharCode(parseInt(code, 16)));
}

function stripTags(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, ' ')).replace(/\s{2,}/g, ' ').trim();
}

function parseSimpleHtml(html: string): HtmlBlock[] {
  if (!html) return [];

  const blocks: HtmlBlock[] = [];
  const headingRe = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const pushParagraphs = (chunk: string) => {
    chunk
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li)>/gi, '\n\n')
      .split(/\n{2,}/)
      .map(stripTags)
      .filter(Boolean)
      .forEach((text) => blocks.push({ heading: false, text }));
  };

  while ((match = headingRe.exec(html)) !== null) {
    pushParagraphs(html.slice(lastIndex, match.index));
    const text = stripTags(match[2]);
    if (text) blocks.push({ heading: true, level: Number(match[1]), text });
    lastIndex = headingRe.lastIndex;
  }
  pushParagraphs(html.slice(lastIndex));

  return blocks;
}

function HtmlBlocks({ html }: { html: string }) {
  const blocks = parseSimpleHtml(html);
  return (
    <>
      {blocks.map((block, i) => (
        <Text
          key={i}
          style={
            block.heading
              ? styles[`heading${Math.min(block.level ?? 3, 3)}` as 'heading1' | 'heading2' | 'heading3']
              : styles.paragraph
          }
        >
          {block.text}
        </Text>
      ))}
    </>
  );
}

// ─── screen ───────────────────────────────────────────────────────────────────

export default function ConsentTemplateScreen() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [template, setTemplate] = useState<ConsentTemplate | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await getConsentTemplate();
        setTemplate(data.template);
      } catch (err: any) {
        setError(
          err?.response?.data?.error || err?.message || 'Could not load the consent document',
        );
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Consent Document' }} />

      {loading ? (
        <ActivityIndicator color={colors.primary} size="large" style={styles.loader} />
      ) : error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>⚠️ {error}</Text>
          <Text style={styles.errorHint}>
            You can still accept or revoke consent from the previous screen — this only
            affects viewing the full document text.
          </Text>
        </View>
      ) : template ? (
        <ScrollView contentContainerStyle={styles.content}>
          <HtmlBlocks html={template.title} />
          <HtmlBlocks html={template.header} />

          {template.modules.map((mod, i) => (
            <View key={i} style={styles.moduleCard}>
              {mod.mandatory && <Text style={styles.mandatoryTag}>Required</Text>}
              <HtmlBlocks html={mod.title || mod.label} />
              <HtmlBlocks html={mod.text} />
            </View>
          ))}

          {!!template.footer && <HtmlBlocks html={template.footer} />}
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}

// ─── styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  loader: { flex: 1, marginTop: 40 },
  content: { padding: spacing.md, gap: 2, paddingBottom: 40 },

  heading1: { ...typography.h2, color: colors.text.primary, marginTop: spacing.sm, marginBottom: spacing.xs },
  heading2: { ...typography.h3, color: colors.text.primary, marginTop: spacing.sm, marginBottom: spacing.xs },
  heading3: {
    ...typography.body, fontWeight: '700', color: colors.text.primary, marginTop: spacing.sm,
  },
  paragraph: { ...typography.body, color: colors.text.secondary, lineHeight: 22, marginBottom: spacing.xs },

  moduleCard: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 2,
    marginTop: spacing.md,
  },
  mandatoryTag: {
    ...typography.small,
    fontWeight: '700',
    color: colors.primary,
    alignSelf: 'flex-start',
    backgroundColor: colors.primary + '15',
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    marginBottom: 4,
  },

  errorBox: { padding: spacing.lg, gap: spacing.sm, marginTop: 40 },
  errorText: { ...typography.body, color: colors.danger, textAlign: 'center' },
  errorHint: { ...typography.caption, color: colors.text.secondary, textAlign: 'center' },
});
