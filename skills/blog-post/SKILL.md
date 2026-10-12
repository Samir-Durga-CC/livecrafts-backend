---
name: blog-post
description: "Use whenever the person asks for a new blog post / article / news post (often only a title): write the whole post, SEO description, excerpt, categories, tags and featured image, and save it as a draft with create_blog_post."
---

# Blog post from a title

The person gives a title (typed or spoken), sometimes a tone, a length or an image choice. You write and save the
whole post as a DRAFT. Nothing is published until a person deploys.

## Workflow (in this order)
1. **Read the request.** Title (keep the person's wording; fix only obvious typos), tone (default: professional and
   friendly), length (default: about 800 words), image choice (see step 4). Language: the language of the title,
   unless the person says otherwise.
2. **Learn the blog.** `list_terms` for the categories and tags in use. `find_posts` type posts for 2-3 recent posts
   and `read_post` one of them when you need the house style (headings, length, voice). Keep it quick.
3. **Write the post** (step "Writing" below).
4. **Featured image** - exactly one of:
   - The person attached an image -> `upload_media_from_chat` with a descriptive title and alt text.
   - The person picked a Media Library image (an id is given) -> use that id. "Use an image from the library" without an
     id -> `find_media` with the topic and pick the most fitting one.
   - The person asked for an AI image, or said nothing about the image -> `generate_image` ONCE: shape landscape, a
     concrete prompt (subject, setting, style matching the site, mood, colours), no text in the picture. Alt text says
     what the picture shows (not "featured image").
   - The person said no image -> skip.
5. **Save.** `create_blog_post` with title, content, excerpt, metaDescription, categories, tags, featuredImageId
   (and approvedNewTerms only for new names the person already agreed to).
6. **Report** in 3-5 short lines: the title, the length in words, the category and tags used, the image, the preview
   link - and the question about suggested new categories / tags, if any. Say it is a draft: they can refine it by chat, voice or by clicking on it, and Deploy publishes it.

## Writing
- **Structure:** a hook intro of 2-3 sentences that says what the reader gets; 3-6 sections with `h2` headings (use
  `h3` only inside a section); short paragraphs (2-4 sentences); a list where it really is a list; a conclusion with a
  clear next step (a question, a call to contact, a related action). No `h1` in the content: the title is the h1.
- **Length:** hit the requested word count within about 10%. 800 words is roughly an intro, 4 sections and a conclusion.
- **Tone:** professional = clear, confident, no slang, no hype. Friendly / casual = warmer, "you", short sentences.
  Formal = no contractions. Persuasive = benefits first, one clear call to action. Always concrete and specific.
- **Truth:** no invented statistics, studies, quotes, prices, customers or dates. If a fact would need a source,
  write it as general advice instead, or leave it out. Do not name competitors.
- **SEO:** pick one main keyword from the title. Use it in the first paragraph, in one h2 and in the meta description.
  Meta description: 140-155 characters, a reason to click, no quotes. Excerpt: 1-2 sentences for the blog listing.
  Slug: leave empty unless the title is very long (then a short keyword slug).
- **Categories:** 1, at most 2, from the site's EXISTING categories (`list_terms`). Never "Uncategorized" when a real
  one fits. If no existing category fits well, you may still name a better new one: `create_blog_post` does NOT create
  it - it saves the post with the most relevant existing category and returns `suggestedNewTerms`.
- **Tags:** 3-6 short topic tags, existing spellings first. New tag names are handled the same way (suggested, not created).
- **New categories / tags need the person's yes.** Put a name in `approvedNewTerms` only when the person agreed
  (the request says new ones are allowed, or they answered yes). After saving, if `suggestedNewTerms` came back, ASK in
  your answer: "No existing category fits exactly - shall I add the new category X (and tags a, b)? Otherwise it stays in Y."
  On yes: `set_post_terms` with the full lists and the new names in `approvedNewTerms`.

## Block markup (core blocks only)
```
<!-- wp:paragraph -->
<p>Intro text with the <strong>main keyword</strong>.</p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading">A section heading</h2>
<!-- /wp:heading -->

<!-- wp:heading {"level":3} -->
<h3 class="wp-block-heading">A sub heading</h3>
<!-- /wp:heading -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li>One point</li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:quote -->
<blockquote class="wp-block-quote"><!-- wp:paragraph -->
<p>Only for a real quote the person gave you.</p>
<!-- /wp:paragraph --></blockquote>
<!-- /wp:quote -->
```
No inline styles, no classes beyond these, no images inside the article unless the person asks (the featured image
is set separately). Escape `&` as `&amp;` in text.

## Changing the post afterwards
It is a normal draft post: `read_post` then `block.text` / `block.replace` / `block.insert` for the article,
`post.field` title / excerpt, `post.meta` `_thumbnail_id` for a new featured image, and `post.meta`
`seo_description` for the SEO description. Each is a draft change the person can revert.
