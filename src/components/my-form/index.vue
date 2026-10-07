<template>
  <view v-for="(obj, index) in  formArr " :key="index"
    :class="`${!obj.valueWidth && obj.align === 'left' ? '' : 'my-far-table '}`"
    :style="`overflow: auto; border-radius: 0; padding: 2vh 0; width: ${obj.valueWidth || '100%'};  ${obj.inline ? 'display: inline-flex;' : 'display: flex; align-items: flex-start; '} ${index + 1 < formArr.length && !obj.inline ? ' border-bottom: 0.1rem solid #f5f5f5;' : ''}`"
    @tap="(e) => onEdit({ e, obj, index, parent: parentObj.parent })
      ">
    <view class="my-center-vertically"
      :style="`${obj.align === 'left' ? 'margin-right: calc(35% - ' + obj.label.length + 'rem);' : ' '}`">
      <text class="my-inline-label" v-if="obj.labelDot" />
      <text class="my-inline-label-transparent" v-else-if="obj.prefix">
        {{ obj.prefix }}
      </text>
      <image v-if="obj.icon" :src="obj.icon" mode="heightFix" style="width: 1rem; height: 1rem; margin-right: 1%;" />
      <text class="my-inline-text" :style="`font-weight: bold; ${obj.labelColor ? 'color: ' + obj.labelColor : ''}`"
        v-if="!obj.labelHidden">
        {{ obj.label }}<!-- ： -->
      </text>
    </view>
    <view class="my-center-vertically my-far-table"
      :style="`${!obj.valueWidth && obj.align === 'left' ? 'width: inherit; ' : obj.labelHidden && obj.editing ? 'width: 100%' : 'width: auto;'}`">
      <view :style="`color: #ACACAC; ${obj.align === 'left' ? 'width: inherit; ' : 'width: auto;'}`"
        class="my-far-table my-center-vertically" v-if="!obj.editing">
        <view v-if="obj.type === 'realDate'" class="my-far-table my-center-vertically"
          :style="`${obj.align === 'left' ? '' : 'width: 100%;'}`">
          <text />
          <picker mode="date" :value="obj.value" @change="(e) => onEditComplete({
            e,
            ...e.detail,
            obj,
            index,
            parent: parentObj.parent,
          })
            ">
            <text class="my-inline-text my-ellipsis"
              :style="`color: ${obj.valueColor ? obj.valueColor : obj.value ? '#181818' : '#ACACAC'};`">
              {{ obj.value || obj.placeholder }}
            </text>
          </picker>
        </view>
        <view v-else-if="obj.type === 'datetime'" class="my-center-vertically"
          :style="`${obj.align === 'left' ? '' : 'width: 100%;'}`">
          <text class="my-inline-text my-ellipsis"
            :style="`color: ${(obj.value || obj.name) ? (obj.valueColor ? obj.valueColor : '#181818') : obj.placeholderColor ? obj.placeholderColor : '#ACACAC'};`">
            {{ obj.name || obj.value || obj.placeholder }}
          </text>
          <u-datetime-picker v-if="obj.datetimeShow" :show="true" v-model="obj.value" mode="datetime" :title="obj.label"
            @close="onDatetimeClose({ obj, index })" @cancel="onDatetimeCancel({ obj, index })"
            @confirm="(e) => onDatetimeConfirm({ ...e, obj, index })" :setFormatter="datetimeFormatter"
            :minDate="obj.minDate" :maxDate="obj.maxDate" />
        </view>
        <view v-else-if="obj.type === 'realSelect'" style="height: 1rem; width: 100%;">
          <picker mode="selector" :value="obj.index" range-key="label" :range="parentObj.options?.[obj.option]" @change="(e) =>
            onSelectChange({
              e,
              name: parentObj.options?.[obj.option]?.[e.detail.value]?.label,
              value: parentObj.options?.[obj.option]?.[e.detail.value]?.value,
              obj,
              index,
              parent: parentObj.parent,
            })
            ">
            <text class="my-inline-text my-ellipsis"
              :style="` color: ${(obj.value || obj.name) ? (obj.valueColor ? obj.valueColor : '#181818') : obj.placeholderColor ? obj.placeholderColor : '#ACACAC'};`">
              {{ obj.name || obj.value || obj.placeholder }}
            </text>
          </picker>
        </view>
        <view v-else-if="obj.type === 'dialog'" class="my-far-table" style="width: 100%">
          {{ obj.placeholder }}
          <!-- JS配置对话框 -->
        </view>
        <view v-else-if="obj.type === 'switch'" class="my-far-table" style="width: 100%">
          <u-switch v-model="obj.name" activeColor="#1EBCA1" size="18"
            @change="(switched) => onSwitchChange({ switched, obj, index })" />
        </view>
        <view v-else-if="obj.type === 'uploader'" style="width: max-content;">
          <view class="my-scrollable-container">
            <u-upload @afterRead="(e) => onUpload({
              e,
              obj,
              index,
              parent: parentObj.parent,
            })
              " :deletable="!parentObj.readOnly" @delete="(e) => onRemove({
    e,
    obj,
    index,
    parent: parentObj.parent,
  })
    " :fileList="obj.valueArr" :name="obj.name" multiple :maxCount="obj.maxCount || 1" width="72px" height="72px">
              <view v-if="!parentObj.readOnly" aria-label="添加图片"
                style="width: 72px; height: 72px; display: flex; align-items: center; justify-content: center; background: #f3f4f6; color: #6b7280; font-size: 36px;">+</view>
            </u-upload>
          </view>
        </view>
        <pickerArea v-else-if="obj.type === 'realRegion'" :defaultRegion="obj.value"
          @getRegion="(regionArr) => onRegionChange({ regionArr, obj, index })">
          <text class="my-inline-text my-ellipsis"
            :style="`max-width: 45vw; color: ${(obj.value || obj.name) ? (obj.valueColor ? obj.valueColor : '#181818') : obj.placeholderColor ? obj.placeholderColor : '#ACACAC'};`">
            {{ obj.name || obj.placeholder }}
          </text>
        </pickerArea>
        <view v-else-if="obj.type === 'checkbox'">
          <u-checkbox-group v-model="obj.selectArr" @change="(e) => onCheck({ e, obj, index, parent: parentObj.parent })"
            :placement="obj.inline ? 'row' : 'column'">
            <view :class="`${!obj.inline && obj.inputArr ? 'my-center-vertically' : ''}`"
              :style="`${!obj.inline ? 'min-width: 100%;' : ''}`" v-for="( o, i ) in  obj.optionArr " :key="o.value">
              <u-checkbox :shape="o.shape" :label="o.label" :name="o.value" :activeColor="o.activeColor">
              </u-checkbox>
              <input v-if="o.checked && obj.inputArr" :type="o.type" v-model="obj.inputArr[i]"
                :placeholder="o.placeholder" class="my-input" style="margin-left: 1.5rem;" />
            </view>
          </u-checkbox-group>
        </view>
        <view v-else-if="obj.type === 'list'"
          :style="`${obj.inline ? 'width: max-content;' : ''}${obj.inline && obj.showDelete !== '' ? 'height: 4rem;' : ''}`">
          <view class="my-scrollable-container" :style="`${obj.inline ? 'display: flex;' : ''}`">
            <view v-for="( str, i ) in  obj.valueArr " :key="i" class="my-center my-center-vertically my-list"
              :style="`margin: 0.25rem; position: relative; ${obj.inline ? '' : 'display: inline-block;'} ${obj.showDelete === i ? 'color: white; background-color: #114FFF;' : 'background-color: rgb(239, 244, 252);'}`"
              @tap.capture="toggleListDelete({ obj, index, i })">
              <text>{{ str }}</text>
              <view v-if="obj.inline && obj.showDelete === i" class="my-center my-center-vertically"
                style="flex-direction: column; position: absolute; bottom: -3rem;">
                <view
                  style="width: 0; height: 0; border-style: solid; border-width: 0 0.5rem 0.5rem 0.5rem; border-color: transparent transparent black transparent;" />
                <view class="my-delete-popup" @tap.capture="onListDelete({ obj, index, i })">
                  删除
                </view>
              </view>
            </view>
            <view class="my-center-vertically my-far-table" v-if="obj.inline">
              <input v-if="obj.showAdd" class="my-input" :focus="true" style="margin: 0 0.25rem;"
                :placeholder="obj.placeholder || '请输入'" placeholder-class="my-input-placeholder"
                @blur="(e) => onListAdd({ obj, index, e })" />
              <view v-if="!obj.showAdd" class="my-center my-center-vertically my-list my-default-button"
                @tap="onListAdd({ obj, index })">
                <view>+ </view>
                <view class="my-inline-text">添加</view>
              </view>
              <view v-if="obj.showAdd" class="my-center my-center-vertically my-list my-save-button my-default-button">
                <view></view>
                <view class="my-inline-text">保存</view>
              </view>
            </view>
          </view>
          <view class="my-center-vertically my-far-table" v-if="!obj.inline">
            <input v-if="obj.showAdd" class="my-input" :focus="true" style="margin: 0 0.25rem;"
              :placeholder="obj.placeholder || '请输入'" placeholder-class="my-input-placeholder"
              @blur="(e) => onListAdd({ obj, index, e })" />
            <view v-if="!obj.showAdd" class="my-center my-center-vertically my-list my-default-button"
              @tap="onListAdd({ obj, index })">
              <view>+ </view>
              <view class="my-inline-text">添加</view>
            </view>
            <view v-if="obj.showAdd" class="my-center my-center-vertically my-list my-default-button my-save-button">
              <view>+</view>
              <view class="my-inline-text">保存</view>
            </view>
            <view v-if="obj.showDelete !== ''"
              class="my-center my-center-vertically my-list my-default-button my-delete-button"
              style="color: red; border: 1px solid red; " @tap.capture="onListDelete({ obj, index, i: obj.showDelete })">
              <view>-</view>
              <view class="my-inline-text">删除</view>
            </view>
          </view>
        </view>
        <view v-else class="my-center-vertically my-value-area"><text />
          <text
            :style="`text-overflow: unset; color: ${(obj.value || obj.name) ? (obj.valueColor ? obj.valueColor : '#181818') : obj.placeholderColor ? obj.placeholderColor : '#ACACAC'}; ${obj.align === 'left' ? 'width: inherit; ' : 'margin-left: 0.5rem;'}`"
            class="my-inline-text my-ellipsis">
            {{ (obj.value !== '' && obj.type === 'password') ? '*'.repeat(6) :
              (obj.name || obj.value || obj.placeholder) }}
          </text>
        </view>
        <u-icon
          v-if="obj.type === 'select' || obj.type === 'realSelect' || obj.type === 'realDate' || obj.type === 'selectArea' || obj.type === 'dialog' || obj.type === 'datetime' || obj.type === 'pop-checkbox'"
          name="arrow-right" style="margin-left: 0.3rem" />
        <u-icon v-else-if="obj.type === 'password' && obj.value !== ''" name="eye" style="margin-left: 0.3rem"
          @tap="togglePassword({ obj, index })" />
        <u-icon v-else-if="obj._type === 'password' && obj.value !== ''" name="eye-off" style="margin-left: 0.3rem"
          @tap="togglePassword({ obj, index })" />
      </view>
      <!-- 支持行内编辑 -->
      <input v-if="obj.editing && obj.type !== 'textarea'" :type="obj.type" v-model="obj.value"
        :placeholder="obj.placeholder" class="my-input" :focus="true" @blur="(e) =>
          onEditComplete({
            obj,
            index,
            ...e.detail,
            parent: parentObj.parent,
          })
          " />
      <text v-if="obj.postfix && !/^http/.test(obj.postfix)"
        :style="`margin-left: 0.3rem; min-width: fit-content; color: ${obj.postfixColor ? obj.postfixColor : '#181818'};`">
        {{ obj.postfix }}
      </text>
      <image v-else-if="obj.postfix" :src="obj.postfix" mode="widthFix"
        style="margin-left: 0.3rem; width: 1rem; height: 1rem;" />
      <view v-if="obj.editing && obj.type === 'textarea'" style="min-width: 45vw;">
        <u-textarea v-model="obj.value" :placeholder="obj.placeholder" placeholderClass="my-input-placeholder"
          :focus="true" @blur="(e) =>
            onEditComplete({
              obj,
              index,
              ...e.detail,
              parent: parentObj.parent,
            })
            " autoHeight :count="obj.maxLength" :maxlength="obj.maxLength || -1" />
      </view>
    </view>
  </view>
  <u-popup :show="localObj.pops.showPop" @close="onPopClose" :closeable="true" :safeAreaInsetBottom="true" :round="10"
    mode="bottom" zIndex="11" overlayStyle="z-index: 11">
    <view>
      <!-- 弹窗标题 -->
      <view class="my-sticky-header" style="padding: 2vh 4vw; position: relative;">
        <view class="my-heading">{{ localObj.pops['弹窗标题'] || '弹窗标题' }}</view>
      </view>
      <!-- 筛选条件 -->
      <view style="padding: 1vh 4vw;" v-for="(obj, i) in localObj.pops.filterArr" :key="i">
        <view v-if="obj.type === 'pop-checkbox'">
          <u-checkbox-group v-model="obj.selectArr" @change="(e) => onCheck({ e, obj })"
            :placement="obj.inline ? 'row' : 'column'">
            <view :class="`${!obj.inline && obj.inputArr ? 'my-center-vertically' : ''}`"
              :style="`${!obj.inline ? 'min-width: 100%;' : ''}`" v-for="( o, i ) in  obj.optionArr " :key="o.value">
              <u-checkbox :shape="o.shape" :label="o.label" :name="o.value" :activeColor="o.activeColor">
              </u-checkbox>
              <input v-if="o.checked && obj.inputArr" :type="o.type" v-model="obj.inputArr[i]"
                :placeholder="o.placeholder" class="my-input" style="margin-left: 1.5rem;" />
            </view>
          </u-checkbox-group>
        </view>
        <view style="display: flex; padding: 4vh 0;">
          <u-button
            :customStyle="`width: 33vw; height: 5vh; background-color: #F2F2F2; color: black; border-radius: 0.25rem; font-size: 1rem;`"
            @click="onPopClose">取消</u-button>
          <u-button
            :customStyle="`width: 33vw; height: 5vh; background: linear-gradient(337deg, #114FFF 0%, #708fe6 100%); color: white; border-radius: 0.25rem; font-size: 1rem;`"
            @click="onPopConfirm">确定</u-button>
        </view>
      </view>
    </view>
  </u-popup>
</template>

<script setup>
import { reactive, watch, computed, onMounted } from "vue";
import pickerArea from '../pick-regions_2.4/components/pick-regions/pick-regions.vue';

//父系入参
const props = defineProps({
  parentObj: {
    type: Object,
    validator(obj) {
      if (obj) {
        if (
          typeof obj.onEdit !== "function" ||
          typeof obj.onEditComplete !== "function"
        )
          return console.log("⚠️表单处理函数未传入");
      }
    },
  },
});

//本地变量和函数
let formArr = computed(() => props.parentObj.formArr.filter((o) => !o.hidden).map(o => {
  if (o.type === 'textarea' && o.value === null) o.value = ''; //null的时候u-textarea会报错
  return o;
}));
let localObj = reactive({
  pops: {
    showPop: false,
    filterArr: {},
  },
});

//弹窗相关⭐

function onPopOpen() {
  console.log("弹窗打开");
  localObj.pops.showPop = true;
}

function onPopClose() {
  if (localObj.pops.showPop === false) return;
  console.log("弹窗关闭");
  localObj.pops['弹窗标题'] = '';
  localObj.pops.filterArr = [];
  localObj.pops.showPop = false;
}

function onPopConfirm() {
  console.log("弹窗确认");
  let [obj] = localObj.pops.filterArr;
  let originalObj = props.parentObj.formArr.find((o) => o.key === obj.key);
  Object.assign(originalObj, obj);
  onPopClose();
}

//时间选择器相关⭐
function onDatetimeClose({ obj, index }) {
  if (obj.datetimeShow === false) return;
  obj.datetimeShow = false;
  // console.log("时间选择器关闭");
}

function onDatetimeCancel({ obj, index }) {
  // console.log("时间选择器取消");
  onDatetimeClose({ obj, index })
}

function onDatetimeConfirm({ mode, value, obj, index }) {
  let name = new Date(value).Format('yyyy-MM-dd hh:mm');
  // console.log("时间选择器确认", name);
  onDatetimeClose({ obj, index })
  onEditComplete({
    obj,
    index,
    name,
    value,
    parent: props.parentObj.parent,
  });
}

function datetimeFormatter(type, value) {
  if (type === 'year') {
    return `${value}年`
  }
  if (type === 'month') {
    return `${value}月`
  }
  if (type === 'day') {
    return `${value}日`
  }
  if (type === 'hour') {
    return `${value}`
  }
  if (type === 'minute') {
    return `${value}`
  }
  return value;
}

//开关相关
function onSwitchChange({ switched, obj, index } = {}) {
  let { valueArr = [{ name: true, value: true }, { name: false, value: false }] } = obj;
  let targetObj = valueArr.find((o) => o.name === switched);
  let { name, value } = targetObj;
  obj.name = name;
  obj.value = value;
  // console.log("开关切换", switched, obj);
}

class form_datetime {
  constructor(obj) {
    obj.datetimeShow = true;
    // console.log("时间选择器打开");
    return obj;
  }
}


class form_readOnly {
  constructor(obj) {
    console.log("只读");
    return obj;
  }
}

class form_internal {
  constructor(obj) {
    // console.log("内部处理");
    return obj;
  }
}

class form_input {
  constructor(obj) {
    obj.editing = true;
    return obj;
  }
}

class form_dialog {
  constructor(obj) {
    obj.fn?.()
    return obj;
  }
}

class form_pop {
  constructor(obj) {
    localObj.pops.filterArr = [{ ...obj }];
    localObj.pops['弹窗标题'] = obj.label;
    onPopOpen();
  }
}

class form_map {
  constructor(obj) {
    // console.log("地图");
    let { latitude, longitude } = obj;
    uni.chooseLocation({
      latitude,
      longitude,
      success: (res) => {
        let { latitude = 0, longitude = 0, name = '', address = '' } = res;
        Object.assign(obj, res, {
          name: latitude && longitude ? `${name}[${address}]` : '',
          value: latitude && longitude ? `[${latitude},${longitude}]` : ''
        })
        console.log("表单已更新", JSON.parse(JSON.stringify(obj)));
        return obj;
      },
      fail: (err) => {
        console.log(err);
        obj.name = '';
        obj.value = '';
        obj.longitude = 0;
        obj.latitude = 0;
        return obj;
      },
    });
  }
}

function onEdit(params) {
  if (props.parentObj.readOnly) return;
  let status = props.parentObj.onEdit?.(params);
  if (typeof status === 'boolean' && !status) return;
  let { obj, index, parent, e } = params;
  // console.log("开始填写表单", obj, index);
  let { type } = obj;
  if (type === undefined) {
    return new form_readOnly(obj);
  } else if (type === 'realSelect' || type === 'realDate' || type === 'select' || type === 'checkbox' || type === 'list' || type === 'uploader' || type === 'switch') {
    return new form_internal({ obj });
  } else if (type === 'datetime') {
    return new form_datetime(obj);
  } else if (type === 'map') {
    return new form_map(obj);
  } else if (type === 'dialog') {
    return new form_dialog(obj);
  } else if (type === 'pop-checkbox') {
    return new form_pop(obj);
  } else if (type === "text" || type === "number" || type === "digit" || type === "textarea" || type === 'password') {
    return new form_input(obj);
  } else {
    console.log(false, "⚠️未知表单类型");
  }
}

function onSelectChange(params) {
  if (props.parentObj.readOnly) return;
  let { e, obj } = params;
  obj.index = e.detail.value; //注意避坑，原生的value是range的index，不是真正的value
  onEditComplete(params);
}

function onEditComplete(params) {
  if (props.parentObj.readOnly) return;
  let status = props.parentObj.onEditComplete?.(params);
  if (typeof status === 'boolean' && !status) return;
  let { obj, index, value, name, parent } = params;
  obj.editing = false;
  obj.value = value;
  obj.name = name;
  console.log("表单已更新", JSON.parse(JSON.stringify(obj)));
}

function togglePassword({ obj, index }) {
  obj._type = obj.type;
  obj.type = obj.type === 'password' ? 'text' : 'password';
  // console.log(`密码框已${obj.type === 'password' ? '隐藏' : '显示'}`)
}

function onListAdd({ obj, index, e }) {
  if (props.parentObj.readOnly) return;
  console.log("列表添加", obj, index, e);
  obj.showDelete = ''; //关闭删除弹窗
  obj.showAdd = !obj.showAdd;
  if (e && e.detail && e.detail.value !== '') {
    let { value } = e.detail;
    if (obj.maxLength) value = value.slice(0, Number(obj.maxLength));
    obj.valueArr.push(value);
    obj.value = obj.valueArr.join(',');
  }
} //列表添加

function toggleListDelete({ obj, index, i }) {
  console.log("列表删除弹窗", obj, index, i);
  if (props.parentObj.readOnly) return;
  obj.showDelete = obj.showDelete !== '' ? '' : i;
} //列表删除弹窗

function onListDelete({ obj, index, i }) {
  if (props.parentObj.readOnly) return;
  console.log("列表删除", obj, index, i);
  obj.valueArr.splice(i, 1);
  obj.value = obj.valueArr.join(',');
  obj.showDelete = '';
} //列表删除

function onCheck({ e, obj }) {
  let selectArr = e;
  if (!Array.isArray(selectArr)) return;
  obj.selectArr = selectArr;
  let { optionArr, inputArr = [] } = obj;
  optionArr.forEach((item, i) => {
    item.checked = selectArr.includes(item.value);
    // if (!item.checked) inputArr.splice(i, 1);
  })
  obj.value = optionArr.filter(item => item.checked).map(item => item.value);
  obj.name = optionArr.filter(item => item.checked).map(item => item.label).join(',');
  console.log("表单已更新", JSON.parse(JSON.stringify(obj)));
  return obj;
} //多选

async function onUpload(paramObj = {}) {
  if (props.parentObj.readOnly) return;
  if (typeof props.parentObj.onUpload !== "function") return console.log("⚠️图片上传处理函数未传入")
  let uploadArr = await props.parentObj.onUpload(paramObj);
  if (typeof uploadArr === 'boolean' && !uploadArr) return;
  Object.assign(paramObj, { uploadArr })
  console.log("图片上传", paramObj);
  onUploadComplete(paramObj);
}

function onUploadComplete(paramObj) {
  if (props.parentObj.readOnly) return;
  let status = props.parentObj.onUploadComplete?.(paramObj);
  if (typeof status === 'boolean' && !status) return;
  let { uploadArr, obj } = paramObj;
  obj.valueArr = [...(obj.valueArr || []), ...uploadArr.map(str => ({ url: str }))];
  obj.value = obj.valueArr.map(obj => obj.url).join(',');
  let { maxLength } = obj;
  if (maxLength && obj.valueArr.length > maxLength) {
    obj.valueArr.length = maxLength;
  };
  console.log("图片上传完成", uploadArr);
}

function onRemove(paramObj) {
  if (props.parentObj.readOnly) return;
  let status = props.parentObj.onRemove?.(paramObj);
  if (typeof status === 'boolean' && !status) return;
  let { e, index, obj, parent } = paramObj;
  obj.valueArr.splice(e.index, 1);
  obj.value = obj.valueArr.map(obj => obj.url).join(',');
  obj.type = ''; //这里是为了解决u-upload的bug，如果不重新赋值，会导致图片无法删除
  setTimeout(() => obj.type = 'uploader', 0);
  console.log("图片删除", obj);
}

function onRegionChange({ regionArr, obj, index }) {
  if (props.parentObj.readOnly) return;
  let value = regionArr[regionArr.length - 1].code;
  let name = regionArr.map(item => item.name).join(', ')
  onEditComplete({
    obj,
    index,
    value,
    name,
    parent: props.parentObj.parent,
  })
}
</script>

<style>
.my-input {
  text-align: left !important;
  font-size: 1rem;
  padding: 0 !important;
  line-height: inherit;
  height: auto;
  min-height: auto;
}

.my-input-placeholder {
  color: #ACACAC;
  text-align: left;
}

.my-inline-label-transparent {
  display: inline-block;
  background-color: transparent;
  height: 1vh;
  width: 0.5rem;
  margin-left: 1.5%;
  margin-right: 1.5%;
  border-radius: 50%;
}

.my-region-text {
  display: flex;
  flex-direction: row-reverse;
  text-overflow: unset;
  width: 43%;
}

.my-value-area {
  width: 100%;
  display: flex;
  justify-content: flex-end;
  height: auto;
}

.my-scrollable-container {
  width: 100%;
}

.my-list {
  padding: 0.25rem 0.5rem;
  min-width: 2rem;
  border-radius: 1rem;
  border: 1px solid #114FFF;
  color: #114FFF;
  font-weight: bold;
  z-index: 1;
}

.my-delete-popup {
  padding: 0.25rem 0.5rem;
  border-radius: 1rem;
  font-size: 0.8rem;
  color: white;
  background-color: black;
  width: max-content;
  z-index: 2;
}

.my-default-button {
  max-width: 20%;
  margin: 0.25rem;
  border: 1px dashed #909399;
  color: #909399;
}

.my-save-button {
  color: #5ac725;
  border: 1px solid #5ac725;
}

.my-delete-button {
  color: #ff3b30;
  border: 1px solid #ff3b30;
}

/* checkbox样式调整 */
view[class *=u-checkbox-label--left] {
  margin-top: 0;
  margin-bottom: 0;
}

view[class *=u-checkbox-group] {
  width: inherit;
  /* min-width: -webkit-fill-available; */
}

/* 弹窗样式👇 */
.my-sticky-header {
  position: sticky;
  top: 0;
}
</style>
