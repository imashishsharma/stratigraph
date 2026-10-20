Alternative to a new issue: a comment on https://github.com/openrewrite/rewrite-hibernate/issues/31 (open, same recipe, UUID-as-char case).

---

A related case with the short registry name instead of the class name. `TypeAnnotationParameter` treats it as a class name and produces code that doesn't parse as a class literal:

```diff
     @Id
-    @Type(type = "uuid-char")
+    @Type(uuid-char.class)
     UUID id;
```

```
[ERROR] ReceivedFile.java:[13,11] cannot find symbol
  symbol:   variable uuid
```

`uuid-binary` -> `@Type(uuid-binary.class)` and `text` -> `@Type(text.class)` do the same. Reproduced with rewrite-spring 6.37.1 (rewrite-hibernate 2.25.0) `UpgradeSpringBoot_3_5`, and `TypeAnnotationParameter` hasn't changed since v2.18.0, so 2.27.0 should behave the same. For `uuid-char`, the Hibernate 6 equivalent that keeps the `char(36)` column is `@JdbcTypeCode(SqlTypes.CHAR)`, which also covers the `UUIDCharType` case in this issue. Minimal project: <link to repro if published>.
