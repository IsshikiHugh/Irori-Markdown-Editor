# Irori 标识

```
irori-logo.svg                              矢量原件（定稿）
irori-logo-{1024,512,256,128,64}.png        透明底 PNG

irori-logo-unlit.svg                        变体：火快熄了 —— 没有烟，炭火只剩最后一点暗红
irori-logo-unlit-{1024,512,256,128,64}.png

irori-logo-animated.svg                     变体：炭火明暗呼吸、烟整条像正弦波一样往上送。纯 SMIL，无脚本无样式，
                                            放进 <img> 就会动（GitHub README 也行）；不支持 SMIL
                                            的地方显示的就是定稿静态图。只有 SVG，没有 PNG。
```

这些是**产物**。要改动请改生成器，不要手改 SVG：

```
design/icon/hearth.gen.mjs   生成器
design/icon/hearth.md        设计文稿 —— 迭代前先读
```

透明底，所以底色由使用方定。已知：缝隙是透明的，放深色底上会消失。
