//! The harness's input paths on a bare Ely control, for features that add forms.

use colab_playground::ui::tagged;
use ely_gpui_component::{
    forms::{Input, TextInput},
    primitives::FocusScope,
};
use gpui::{
    AppContext as _, Context, Entity, FocusHandle, IntoElement, ParentElement, Render, Styled,
    TestAppContext, Window,
};

use crate::support::{click_at, mount, settle};

struct Field {
    focus: FocusHandle,
    input: Entity<TextInput>,
}

impl Render for Field {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        FocusScope::new(&self.focus)
            .root()
            .size_full()
            .child(tagged("field", Input::new(&self.input)))
    }
}

#[gpui::test]
fn text_typed_after_a_click_lands_in_the_ely_input(cx: &mut TestAppContext) {
    let (view, cx) = mount(cx, |window, cx| Field {
        focus: cx.focus_handle(),
        input: cx.new(|cx| TextInput::new(window, cx)),
    });
    let field = cx.debug_bounds("field").expect("the field is drawn");
    click_at(cx, field.center());
    cx.simulate_input("4/0AbC-dEf");
    settle(cx);
    let input = view.read_with(cx, |view, _| view.input.clone());
    assert_eq!(
        input.read_with(cx, |input, _| input.text().to_owned()),
        "4/0AbC-dEf"
    );
    cx.simulate_keystrokes("backspace backspace");
    settle(cx);
    assert_eq!(
        input.read_with(cx, |input, _| input.text().to_owned()),
        "4/0AbC-d"
    );
}
