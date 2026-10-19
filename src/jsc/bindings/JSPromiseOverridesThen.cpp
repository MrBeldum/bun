#include "root.h"
#include <JavaScriptCore/JSCInlines.h>
#include <JavaScriptCore/JSPromise.h>
#include <JavaScriptCore/JSPromisePrototype.h>

// A class of the promise has its own `then`. A replaced `Promise.prototype.then` does not count. Runs no script.
extern "C" [[ZIG_EXPORT(nothrow)]] bool JSC__JSPromise__overridesThen(JSC::JSPromise* promise)
{
    auto& vm = promise->vm();
    JSC::JSObject* promisePrototype = promise->realm()->promisePrototype();
    for (JSC::JSObject* object = promise; object != promisePrototype;) {
        if (object->type() == JSC::ProxyObjectType || object->getDirectOffset(vm, vm.propertyNames->then) != JSC::invalidOffset)
            return true;
        JSC::JSValue prototype = object->getPrototypeDirect();
        if (!prototype.isObject())
            return false;
        object = JSC::asObject(prototype);
    }
    return false;
}

// What `JSValue::structure_id` reads for a promise of this realm that no class and no own property has reshaped.
extern "C" [[ZIG_EXPORT(nothrow)]] uint32_t JSC__JSGlobalObject__promiseStructureID(JSC::JSGlobalObject* globalObject)
{
    static_assert(JSC::JSCell::structureIDOffset() == 0);
    static_assert(sizeof(JSC::StructureID) == sizeof(uint32_t));
    return globalObject->promiseStructure()->id().bits();
}
