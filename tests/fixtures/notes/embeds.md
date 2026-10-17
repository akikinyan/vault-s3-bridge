---
cover: "[[assets/examples/png-plain.png]]"
tags: [sample]
---

# 埋め込み検証

通常：![[assets/examples/png-plain.png]]

標準記法：![alt](assets/examples/webp-plain.webp)

山括弧：![空白 名](<assets/examples/gif-static.gif>)

| 列1 | 列2 |
|---|---|
| ![[assets/examples/png-meta.png\|100]] | ![t](assets/examples/jpeg-gps-rot6.jpg) |

> [!note] コールアウト
> ![[assets/examples/webp-meta.webp]]

```
![[code-fence-should-be-ignored.png]]
```

~~~md
![[tilde-fence-should-be-ignored.png]]
~~~

> ```
> ![[quote-fence-should-be-ignored.png]]
> ```

- リスト
  ```
  ![[list-fence-should-be-ignored.png]]
  ```

インライン `![[inline-should-be-ignored.png]]` と ``二重 ` ![[double-backtick-ignored.png]]`` の後：![[assets/examples/jpeg-gps-rot1.jpg]]

%% ![[percent-comment-ignored.png]] %%

%%
![[percent-block-ignored.png]]
%%

<!-- ![[html-comment-ignored.png]] -->

字下げコード：

    ![[indented-code-should-be-ignored.png]]

$$
![[math-block-ignored.png]]
$$

エスケープ：\![[escaped-should-be-ignored.png]]

- リスト項目
    ![[list-continuation-4spaces.png]]

インライン数式 $![[inline-math.png]]$ の後

<div>
![[html-block.png]]
</div>

> > ![[nested-quote.png]]

@@@
![[assets/examples/apng-anim.png]]
