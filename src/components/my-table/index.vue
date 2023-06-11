<template>
  <view class="table_box" :style="`min-height: auto;`">
    <!-- 表头 -->
    <view class="tr bg-w my-center-vertically">
      <view v-for="({ width, label, pinned }, index) in parentObj?.tableColumn" :key="index"
        :class="`th my-center my-center-vertically ${pinned === 'left' ? 'pinned-left' : pinned === 'right' ? 'pinned-right' : ' '} ${pinned && index === parentObj.tableColumn.length - 1 ? 'pinned-first' : ''}`"
        :style="`${width ? 'width:' + width : ''};`">
        {{ label }}
      </view>
    </view>
    <!-- 表体 -->
    <view class="tr bg-g my-center-vertically" v-for="(obj, i) in parentObj?.tableRow" :key="i">
      <view
        v-for="({ key, label, prefix, postfix, width, pinned, color, backgroundColor, backgroundColor2, label2, color2 }, index) in parentObj?.tableColumn"
        :key="index"
        :class="`td my-center my-center-vertically ${pinned === 'left' ? 'pinned-left' : pinned === 'right' ? 'pinned-right' : ''} ${pinned && i === parentObj.tableRow.length - 1 ? 'pinned-last' : pinned ? 'pinned' : ''}`"
        :style="`${width ? 'width: ' + width : ''}; ${label2 ? ' flex-direction: column;' : ''};`"
        @tap="parentObj?.onTable({ rowObj: obj, row: i, col: index, colObj: parentObj?.tableColumn[index] })">
        <view class="my-center my-center-vertically" v-if="!obj.editing">
          <view class="my-inline-text my-ellipsis"> {{ obj[prefix] || prefix || '' }} </view>
          <view
            :style="`${color ? 'color: ' + color : ''}; ${backgroundColor ? 'padding: 0.25rem 0.5rem; margin-right: 0.25rem; background-color: ' + backgroundColor : ''}`"
            class="my-inline-text my-ellipsis"> {{ obj[key] !== undefined ? obj[key] : obj[label] !== undefined ?
              obj[label] : key !== undefined ? key :
                label }}
          </view>
          <view class="my-inline-text my-ellipsis"> {{ obj[postfix] || postfix || '' }} </view>
        </view>
        <input v-else type="text" v-model="obj[key]" :focus="true"
          @confirm="parentObj?.onTable({ rowObj: obj, row: i, col: index, colObj: parentObj?.tableColumn[index], modified: true })" />
        <view v-if="label2"
          :style="`${color2 ? 'color: ' + color2 : ''}; ${backgroundColor2 ? 'font-size: 0.75rem; border-radius: 0.5rem; padding: 0.25rem; background-color: ' + backgroundColor2 : ''}`">
          <view class="my-inline-text my-ellipsis"> {{ obj[key2] !== undefined ? obj[key2] : obj[label2] !== undefined ?
            obj[label2] : key2 !== undefined ?
              key2 : label2 }}
          </view>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
//框架引入
import {
  reactive,
  watch,
  computed,
  onMounted,
  onActivated,
  onDeactivated,
  onUpdated,
  defineProps,
} from "vue";

//组件引入

//父系入参
const props = defineProps({
  parentObj: Object,
});
</script>

<style>
.table_box {
  /* border-radius: 0.5rem; */
  overflow-y: scroll;
  overflow-x: visible;
  width: 100%;
  /* padding: 0.5rem; */
}

.my-table-pop {
  position: absolute;
  top: 2.2rem;
  box-shadow: 0px 3px 6px rgba(0, 0, 0, 0.16);
  border-radius: 2px;
  z-index: 2;
}

.my-table-pop-menu {
  width: 6.125rem;
  height: 3rem;
  color: #7B7B7B;
  background-color: white;
}

.my-table-pop-menu-selected,
.my-table-pop-menu:hover {
  color: #008DFF;
  background-color: #E5F3FF
}

.tr {
  display: flex;
  justify-content: space-between;
  width: max-content;
  min-width: 100%;
}

.bg-w {
  height: 5vh;
  background-color: #EAF5F3;
  color: #6B807C;
}

.bg-g {
  height: 5vh;
  background-color: #fff;
  border-bottom: 1px solid #f7f6fb;
  color: #181818;
}

.tr .th,
.tr .td {
  position: relative;
  padding: 0 0.2rem;
  min-width: 6rem;
  max-width: 10rem;
}

.tr .null {
  text-align: center;
}

.tr .total {
  color: #fa5151;
}

/* 固定某一列在最右侧，包括thead和tbody */
.pinned-left {
  position: sticky !important;
  background-color: inherit;
  height: 100%;
  left: 0;
  z-index: 1;
}

.pinned-right {
  position: sticky !important;
  background-color: inherit;
  height: 100%;
  right: 0;
  z-index: 1;
}

.pinned {
  box-shadow: -1px -0px 2px rgba(0, 0, 0, 0.14);
}

.pinned-first {
  box-shadow: -1px -1px 2px rgba(0, 0, 0, 0.14);
  position: absolute !important;
  height: inherit;
}

.pinned-last {
  box-shadow: -1px 2px 2px rgba(0, 0, 0, 0.14);

}
</style>
