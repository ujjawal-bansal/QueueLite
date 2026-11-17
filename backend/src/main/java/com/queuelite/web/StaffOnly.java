package com.queuelite.web;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/** The route exposes or changes patient data: a signed-in staff session is required. */
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface StaffOnly {}
