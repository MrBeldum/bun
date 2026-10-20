#!/usr/bin/env python3
# Writes the Bun.serve change (third shape: subscribe to the follower, then drain; the cold functions take the promise only) into the working tree,
# from the origin/main version of each file.
#   apply_b.py <commits> <gate>
#     commits: 1 = follow a fulfilled promise that holds no Response; 2 = + follow a pending promise
#     gate:    cpp  = the plain-promise test is inside the C++ predicate
#              rust = + an inline StructureID compare in Rust before the predicate (needs commits=2)
import os, subprocess, sys
REPO = '/workspace/bun'
N = int(sys.argv[1]); GATE = sys.argv[2] if len(sys.argv) > 2 else 'cpp'
def base(rel):
    return subprocess.run(['git', '-C', REPO, 'show', 'origin/main:' + rel], capture_output=True, text=True, check=True).stdout
def once(s, old, new, label=''):
    assert s.count(old) == 1, (label, s.count(old), old[:90])
    return s.replace(old, new)
out = {}
RUST_GATE = (GATE == 'rust' and N >= 2)

cpp = '''#include "root.h"
#include <JavaScriptCore/JSCInlines.h>
#include <JavaScriptCore/JSPromise.h>
#include <JavaScriptCore/JSPromisePrototype.h>

// The promise or a class of it has a `then`, a function or an accessor, before any `Promise.prototype`.
extern "C" [[ZIG_EXPORT(nothrow)]] bool JSC__JSPromise__hasCustomThen(JSC::JSGlobalObject* globalObject, JSC::JSPromise* promise)
{
    if (promise->structure() == globalObject->promiseStructure()) [[likely]]
        return false;
    auto& vm = JSC::getVM(globalObject);
    auto scope = DECLARE_TOP_EXCEPTION_SCOPE(vm);
    // VMInquiry: the lookup runs no script. A Proxy on the way taints the slot instead.
    JSC::PropertySlot slot(promise, JSC::PropertySlot::InternalMethodType::VMInquiry, &vm);
    bool found = promise->getNonIndexPropertySlot(globalObject, vm.propertyNames->then, slot);
    scope.assertNoExceptionExceptTermination();
    if (slot.isTaintedByOpaqueObject())
        return true;
    if (!found || slot.slotBase()->inherits<JSC::JSPromisePrototype>())
        return false;
    return !slot.isValue() || slot.getPureResult().isCallable();
}
'''
if RUST_GATE:
    cpp += '''
static_assert(JSC::JSCell::structureIDOffset() == 0, "AnyPromise::structure_id reads the StructureID at offset 0");
static_assert(sizeof(JSC::StructureID) == sizeof(uint32_t), "AnyPromise::structure_id reads the StructureID as a u32");

// What `AnyPromise::structure_id` reads for a promise of this realm that no class and no own property has reshaped.
extern "C" [[ZIG_EXPORT(nothrow)]] uint32_t JSC__JSGlobalObject__promiseStructureID(JSC::JSGlobalObject* globalObject)
{
    return globalObject->promiseStructure()->id().bits();
}
'''
out['src/jsc/bindings/JSPromiseCustomThen.cpp'] = cpp

s = base('src/jsc/JSPromise.rs')
s = once(s, '''    pub fn set_handled(&mut self) {
        JSC__JSPromise__setHandled(self)
    }

    /// Create a new resolved promise resolving to a given value.
''', '''    pub fn set_handled(&mut self) {
        JSC__JSPromise__setHandled(self)
    }

    /// This promise has a `then` that is not the one of a `Promise.prototype`. The lookup runs no script.
    pub fn has_custom_then(&self, global: &JSGlobalObject) -> bool {
        crate::cpp::JSC__JSPromise__hasCustomThen(global, self)
    }

    /// Create a new resolved promise resolving to a given value.
''', 'jspromise')
out['src/jsc/JSPromise.rs'] = s

s = base('src/jsc/AnyPromise.rs')
extra = ''
if RUST_GATE:
    extra = '''    /// The `StructureID` of the cell. In Rust for the reason `JSValue::js_type` is.
    #[inline]
    pub fn structure_id(self) -> u32 {
        // SAFETY: a promise is a cell, and a cell starts with its `StructureID`, an aligned `u32`.
        unsafe { *self.as_js_promise().cast::<u32>() }
    }

'''
s = once(s, '''    #[inline]
    pub fn resolve(self, global_this: &JSGlobalObject, value: JSValue) -> JsResult<()> {
        any_promise_dispatch!(self, |p| p.resolve(global_this, value))
    }
''', '''    /// See [`JSPromise::has_custom_then`].
    #[inline]
    pub fn has_custom_then(self, global: &JSGlobalObject) -> bool {
        JSPromise::opaque_ref(self.as_js_promise()).has_custom_then(global)
    }

''' + extra + '''    #[inline]
    pub fn resolve(self, global_this: &JSGlobalObject, value: JSValue) -> JsResult<()> {
        any_promise_dispatch!(self, |p| p.resolve(global_this, value))
    }
''', 'anypromise')
out['src/jsc/AnyPromise.rs'] = s

s = base('src/runtime/server/mod.rs')
if RUST_GATE:
    s = once(s, '''    pub global_this: *const jsc::JSGlobalObject,
    /// Packed tagged-pointer wire-format `AnyServer` for this
''', '''    pub global_this: *const jsc::JSGlobalObject,
    /// `AnyPromise::structure_id` of a plain promise of `global_this`, read once in [`Self::init`].
    pub(crate) promise_structure_id: u32,
    /// Packed tagged-pointer wire-format `AnyServer` for this
''', 'mod-field')
    s = once(s, '''            global_this: std::ptr::from_ref(global),
            // Set below, once the server has its final (stable) heap address.
            any_server_packed: 0,
''', '''            global_this: std::ptr::from_ref(global),
            promise_structure_id: bun_jsc::cpp::JSC__JSGlobalObject__promiseStructureID(global),
            // Set below, once the server has its final (stable) heap address.
            any_server_packed: 0,
''', 'mod-init')
    s = once(s, '''pub(crate) trait ServerLike {
    fn global_this(&self) -> &jsc::JSGlobalObject;
''', '''pub(crate) trait ServerLike {
    fn global_this(&self) -> &jsc::JSGlobalObject;
    /// See [`NewServer::promise_structure_id`].
    fn promise_structure_id(&self) -> u32;
''', 'mod-trait')
    s = once(s, '''    #[inline(always)]
    fn global_this(&self) -> &jsc::JSGlobalObject {
        Self::global_this(self)
    }
    #[inline(always)]
    fn vm(&self) -> &jsc::VirtualMachine {
        Self::vm(self)
    }
''', '''    #[inline(always)]
    fn global_this(&self) -> &jsc::JSGlobalObject {
        Self::global_this(self)
    }
    #[inline(always)]
    fn promise_structure_id(&self) -> u32 {
        self.promise_structure_id
    }
    #[inline(always)]
    fn vm(&self) -> &jsc::VirtualMachine {
        Self::vm(self)
    }
''', 'mod-impl')
out['src/runtime/server/mod.rs'] = s

s = base('src/runtime/server/RequestContext.rs')
s = once(s, '''    // - If you return a Promise, we drain the microtask queue once
    // - If you return a streaming Response, we drain the microtask queue (possibly the 2nd time this task!)
''', '''    // - If you return a Promise, we drain the microtask queue once
    // - If you return a streaming Response, we drain the microtask queue (possibly the 2nd time this task!)
    // - If you return a promise that has its own `then()`, we drain once more, for the microtask that calls it
''', 'drains')

if N >= 2:
    assert RUST_GATE
    s = once(s, '''                jsc::PromiseResult::Pending => {
                    let cell = ctx.create_promise_cell(this.global_this());
                    response_value.then_with_value(
                        this.global_this(),
                        cell,
                        Self::ON_RESOLVE,
                        Self::ON_REJECT,
                    ); // TODO: properly propagate exception upwards
                    return;
                }
''', '''                jsc::PromiseResult::Pending => {
                    if promise.structure_id() != this.promise_structure_id() {
                        ctx.on_pending_promise_not_plain(promise);
                        return;
                    }
                    let cell = ctx.create_promise_cell(this.global_this());
                    response_value.then_with_value(
                        this.global_this(),
                        cell,
                        Self::ON_RESOLVE,
                        Self::ON_REJECT,
                    ); // TODO: properly propagate exception upwards
                    return;
                }
''', 'pending')

s = once(s, '''                    if fulfilled_value.is_empty_or_undefined_or_null() {
                        ctx.render_missing_invalid_response(fulfilled_value);
                        return;
                    }
                    // `fulfilled_value` is rooted via ensure_still_alive() /
                    // protect() below for as long as `response` is used.
                    let Some(response) = as_response(fulfilled_value) else {
                        ctx.render_missing_invalid_response(fulfilled_value);
                        return;
                    };
''', '''                    if fulfilled_value.is_empty_or_undefined_or_null() {
                        ctx.on_promise_without_response(promise, fulfilled_value);
                        return;
                    }
                    // `fulfilled_value` is rooted via ensure_still_alive() /
                    // protect() below for as long as `response` is used.
                    let Some(response) = as_response(fulfilled_value) else {
                        ctx.on_promise_without_response(promise, fulfilled_value);
                        return;
                    };
''', 'fulfilled')

s = once(s, '''        // A truthy non-Response, non-Error, non-Promise value (object, string,
        // number, ...). The async twin (`handle_resolve`) reports this via
        // `render_missing_invalid_response`; do the same on the sync path.
        ctx.render_missing_invalid_response(response_value);
    }

    pub(crate) fn handle_resolve_stream(&self) {
''', '''        // A truthy non-Response, non-Error, non-Promise value (object, string,
        // number, ...). The async twin (`handle_resolve`) reports this via
        // `render_missing_invalid_response`; do the same on the sync path.
        ctx.render_missing_invalid_response(response_value);
    }

    /// A handler's promise holds no Response. One with its own `then()` can hold a placeholder (an SDK's `APIPromise`).
    #[cold]
    #[inline(never)]
    fn on_promise_without_response(&self, promise: jsc::AnyPromise, fulfilled_value: JSValue) {
        if promise.has_custom_then(self.server().global_this()) && self.follow_then(promise) {
            return;
        }
        self.render_missing_invalid_response(fulfilled_value);
    }

    /// A handler's pending promise is a subclass, has own properties, or is of another realm. One with its own `then()` can start its work there (`Bun.$`, a `Bun.SQL` query).
    #[cold]
    #[inline(never)]
    fn on_pending_promise_not_plain(&self, promise: jsc::AnyPromise) {
        let global = self.server().global_this();
        if promise.has_custom_then(global) && self.follow_then(promise) {
            return;
        }
        let cell = self.create_promise_cell(global);
        promise.as_value().then_with_value(global, cell, Self::ON_RESOLVE, Self::ON_REJECT);
    }

    /// Answers with what the `then()` of a handler's promise reports. `false`: `then` gave nothing to call.
    #[cold]
    #[inline(never)]
    fn follow_then(&self, promise: jsc::AnyPromise) -> bool {
        let this = self.server();
        let global = this.global_this();
        let promise_value = promise.as_value();
        let follower = jsc::JSPromise::create(global);
        if follower.resolve(global, promise_value).is_err() {
            return true;
        }
        let nothing_to_call = follower.status() == jsc::PromiseStatus::Fulfilled;
        let waited_on = if nothing_to_call { promise_value } else { follower.to_js() };
        // `then` can be an accessor, which ran script: the request can be gone, as after the handler.
        if self.is_aborted_or_ended() || self.did_upgrade_web_socket() {
            self.discard_handler_result(global, waited_on);
            return true;
        }
        if self.resp.get().is_some_and(|resp| resp.is_closed()) {
            self.on_connection_closed_during_dispatch(this, waited_on);
            return true;
        }
        if nothing_to_call {
            return false;
        }
        let cell = self.create_promise_cell(global);
        waited_on.then_with_value(global, cell, Self::ON_RESOLVE, Self::ON_REJECT);
        // The microtask that calls `then()` runs here. A `then()` that reports at once is answered in this dispatch.
        let _ = self.drain_microtasks();
        true
    }

    pub(crate) fn handle_resolve_stream(&self) {
''', 'helpers')
out['src/runtime/server/RequestContext.rs'] = s

for rel, text in out.items():
    path = os.path.join(REPO, rel)
    cur = open(path).read() if os.path.exists(path) else None
    if cur != text:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, 'w').write(text)
print("applied: commits", N, "gate", GATE)
