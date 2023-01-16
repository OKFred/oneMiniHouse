<template>
  <input :value="parentObj.userSearch" :placeholder="parentObj.placeholder" placeholder-class="my-search-placeholder"
    class="my-search" @confirm="(e) => parentObj.onSearch({e, ...e.detail, parent: parentObj.parent})"
    :selection-start="0" :selection-end="parentObj.userSearch?.length" confirm-type="search" />
</template>

<script setup>
import Taro from "@tarojs/taro";
import { reactive, watch, onMounted } from "vue";

//父系入参
const props = defineProps({
  parentObj: {
    type: Object,
    validator(obj) {
      if (obj) {
        if (
          typeof obj.onSearch !== "function"
        )
          return console.log("⚠️搜索处理函数未传入");
      }
    },
  },
});


definePageConfig({
  navigationStyle: "custom",
  usingComponents: {
  },
});
</script>

<style>
.my-search {
  background-color: white;
  border-radius: 0.25rem;
  padding-left: 1rem;
  font-size: 1.1rem;
}

.my-search-placeholder {
  font-size: 1.1rem;
  color: #ACACAC;
}
</style>
