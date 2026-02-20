<script setup lang="ts">
  /**
   * MarkdownRenderer
   *
   * Renders a Markdown string safely using Vue's virtual DOM (h() render
   * function) — no v-html, no raw HTML injection of any kind.
   *
   * Supported block tokens : heading, paragraph, list, space
   * Supported inline tokens: text, strong, em
   *
   * Unknown tokens fall back to plain text, so the component degrades
   * gracefully for any content that doesn't match the expected structure.
   */
  import { computed, h, type VNode } from "vue";
  import { marked, type Token, type Tokens } from "marked";

  const props = defineProps<{ source: string }>();

  // ---------------------------------------------------------------------------
  // Inline token → VNode
  // ---------------------------------------------------------------------------
  function renderInlineTokens(tokens: Token[] | undefined): VNode[] {
    if (!tokens?.length) return [];

    return tokens.map((token) => {
      switch (token.type) {
        case "strong":
          return h(
            "strong",
            renderInlineTokens((token as Tokens.Strong).tokens)
          );
        case "em":
          return h("em", renderInlineTokens((token as Tokens.Em).tokens));
        case "text":
          return h("span", (token as Tokens.Text).text);
        default:
          // Graceful fallback: render raw text so nothing is lost
          return h("span", token.raw);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Block token → VNode
  // ---------------------------------------------------------------------------
  function renderToken(token: Token): VNode | null {
    switch (token.type) {
      case "heading": {
        const t = token as Tokens.Heading;
        const tag = `h${Math.min(t.depth, 6)}` as keyof HTMLElementTagNameMap;
        return h(
          tag,
          { class: `md-h${t.depth}` },
          renderInlineTokens(t.tokens)
        );
      }

      case "paragraph": {
        const t = token as Tokens.Paragraph;
        return h("p", { class: "md-p" }, renderInlineTokens(t.tokens));
      }

      case "list": {
        const t = token as Tokens.List;
        const tag = t.ordered ? "ol" : "ul";
        const items = t.items.map((item) => {
          // Each list_item has its own tokens array
          const childTokens: Token[] = item.tokens ?? [];
          // Inline text tokens live inside a nested "text" block token
          const inlineTokens: Token[] = childTokens.flatMap((child) =>
            child.type === "text"
              ? ((child as Tokens.Text).tokens ?? [child])
              : [child]
          );
          return h("li", { class: "md-li" }, renderInlineTokens(inlineTokens));
        });
        return h(tag, { class: "md-list" }, items);
      }

      case "space":
        return null;

      default:
        // Unknown block token: render raw as plain text inside a <p>
        return token.raw?.trim() ? h("p", { class: "md-p" }, token.raw) : null;
    }
  }

  // ---------------------------------------------------------------------------
  // Full document
  // ---------------------------------------------------------------------------
  const nodes = computed<VNode[]>(() => {
    const text = props.source?.trim();
    if (!text) return [];

    const tokens = marked.lexer(text);
    return tokens.map(renderToken).filter((n): n is VNode => n !== null);
  });
</script>

<template>
  <div class="markdown-body">
    <component :is="() => nodes" />
  </div>
</template>

<style scoped>
  .markdown-body {
    line-height: 1.7;
    color: var(--color-text-secondary);
  }

  .markdown-body :deep(.md-h2),
  .markdown-body :deep(.md-h3) {
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--color-text);
    margin: 1.25rem 0 0.5rem;
  }

  .markdown-body :deep(.md-h2:first-child),
  .markdown-body :deep(.md-h3:first-child) {
    margin-top: 0;
  }

  .markdown-body :deep(.md-p) {
    margin: 0 0 0.75rem;
    word-wrap: break-word;
  }

  .markdown-body :deep(.md-list) {
    padding-left: 1.25rem;
    margin: 0.25rem 0 0.75rem;
  }

  .markdown-body :deep(.md-li) {
    margin-bottom: 0.3rem;
    line-height: 1.6;
  }

  .markdown-body :deep(strong) {
    color: var(--color-text);
    font-weight: 600;
  }

  .markdown-body :deep(em) {
    font-style: italic;
  }
</style>
