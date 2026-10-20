package com.example;
class Use {
    String m(OldOuter<String>.Registry r) {
        return r.get().trim();
    }
}
