# 埋め込み検証 2

外部 URL：![](https://example.com/a.png) と ![説明](http://example.com/b.png)

参照：![x](s3-bridge://demo/k/a.png)

タイトル付き：![t](assets/examples/png-plain.png "タイトル")

見出し付き：![[assets/examples/png-plain.png#見出し]]

ブロック参照：![[assets/examples/png-plain.png^abc]]

区切り 2 つ：![[assets/examples/png-plain.png|説明|300]]

ノート埋め込み：![[置換検証]]

サイズ：![[assets/examples/png-plain.png|300]] ![[assets/examples/png-plain.png|300x200]] ![説明|300x200](assets/examples/png-plain.png)

括弧入りパス：![p](assets/examples/a(1).png) と ![q](assets/examples/a%20b.png)

二重バックスラッシュ：\\![[double-backslash.png]]

リンクの中：[![[in-link.png]]](https://example.com)

連続：![[a1.png]]![[a2.png]]

行をまたぐインラインコード：`前
![[inline-code-two-lines.png]] 後`

ドル：$5 と ![[dollar-text.png]] と $6

数式 $x$ の後 ![[after-math.png]]

<details>
![[html-details.png]]
</details>

<span>![[html-inline-span.png]]</span>

段落の直後の表
| a | b |
|---|---|
| ![[table-after-paragraph.png]] | x |

| 先頭 | パイプ |
|---|---|
| ![[table-row.png\|200]] | ![t](table-md.png) |
続きの行 ![[table-lazy-row.png]]

c | d
--|--
![[table-no-pipe.png]] | y

> | 引用 | 表 |
> |---|---|
> | ![[quote-table.png]] | z |

1. 番号付き
   ![[ordered-continuation.png]]

    ![[indented-after-list-blank.png]]

本文

	![[tab-indented-code.png]]

- 箇条書き

  ![[list-blank-then-indent.png]]

~~~
![[tilde-unclosed-check-closed.png]]
~~~

````
```
![[nested-fence.png]]
```
````

<!--
![[multi-line-html-comment.png]]
-->

コード内の記号：`%%` の後 ![[after-code-percent.png]] と `<!--` の後 ![[after-code-comment.png]]

```
%%
```

フェンスの後 ![[after-fence-percent.png]]

表の外の区切り：![[assets/examples/png-plain.png\|300]]

> [!note] 表入りコールアウト
> | e | f |
> |---|---|
> | ![[callout-table.png]] | w |

最後 ![[last.png]]
